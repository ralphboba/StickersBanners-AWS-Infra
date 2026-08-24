import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Duration } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { EnvironmentConfig } from '../config/types';

export interface WorkflowStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly cluster: ecs.ICluster;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.ISecurityGroup;
  /** resize / finish / proof task definitions (from the ECS stack). */
  readonly taskDefinitions: Record<string, ecs.FargateTaskDefinition>;
  readonly jobsTable: dynamodb.ITable;
  readonly intakeQueue: sqs.IQueue;
  readonly ftpQueue: sqs.IQueue;
  readonly notifyQueue: sqs.IQueue;
}

/**
 * Order pipeline orchestration (Week 7) — AWS Step Functions (Standard).
 *
 * The "conductor" that finally wires the pieces into one flow:
 *
 *   MarkProcessing -> Resize -> Finish -> NeedsProof?
 *      yes -> Proof -> WaitForApproval (waitForTaskToken) -\
 *      no  ------------------------------------------------>- Route?
 *   Route: transport present -> SendToTransfer -> Notify -> MarkDone
 *          else (UNROUTED)   -> MarkHeld (manual assignment)
 *   Any failure -> MarkFailed -> NotifyFailure -> Fail
 *
 * Standard workflow (supports the long human approval wait). At ~9k orders/mo
 * this costs roughly $3/month; ECS tasks run on demand (no idle cost).
 * Container images are still placeholders, so this defines and tests the
 * orchestration without changing the $0-idle posture.
 */
export class WorkflowStack extends cdk.Stack {
  public readonly stateMachine: sfn.StateMachine;
  public readonly starter: lambda.Function;

  constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, props);

    const { config, cluster, vpc, securityGroup, taskDefinitions, jobsTable, notifyQueue, intakeQueue } = props;
    void vpc;

    const orderPk = sfn.JsonPath.format('ORDER#{}', sfn.JsonPath.stringAt('$.orderName'));

    // --- failure handling (shared catch target) ---
    const markFailed = new tasks.DynamoUpdateItem(this, 'MarkFailed', {
      table: jobsTable,
      key: {
        PK: tasks.DynamoAttributeValue.fromString(orderPk),
        SK: tasks.DynamoAttributeValue.fromString('META'),
      },
      updateExpression: 'SET #s = :s, GSI1PK = :g',
      expressionAttributeNames: { '#s': 'status' },
      expressionAttributeValues: {
        ':s': tasks.DynamoAttributeValue.fromString('failed'),
        ':g': tasks.DynamoAttributeValue.fromString('STATUS#failed'),
      },
      resultPath: sfn.JsonPath.DISCARD,
    });
    const notifyFailure = new tasks.SqsSendMessage(this, 'NotifyFailure', {
      queue: notifyQueue,
      messageGroupId: 'notify',
      messageBody: sfn.TaskInput.fromObject({
        type: 'order-failed',
        orderName: sfn.JsonPath.stringAt('$.orderName'),
      }),
    });
    const failState = new sfn.Fail(this, 'Failed', { error: 'PipelineError' });
    markFailed.next(notifyFailure).next(failState);

    const catchProps: sfn.CatchProps = { resultPath: '$.error' };

    // --- helper: an ECS RunTask step (sync), passing the job to the container ---
    const runTask = (id: string, key: string): tasks.EcsRunTask => {
      const taskDef = taskDefinitions[key];
      const step = new tasks.EcsRunTask(this, id, {
        cluster,
        taskDefinition: taskDef,
        launchTarget: new tasks.EcsFargateLaunchTarget(),
        integrationPattern: sfn.IntegrationPattern.RUN_JOB, // wait for completion
        // No-NAT ($0) layout: tasks run in PUBLIC subnets with a public IP for
        // egress (ECR pull, S3, OrderDesk). With NAT (prod) they stay private.
        subnets: {
          subnetType:
            config.network.natGateways > 0
              ? ec2.SubnetType.PRIVATE_WITH_EGRESS
              : ec2.SubnetType.PUBLIC,
        },
        securityGroups: [securityGroup],
        assignPublicIp: config.network.natGateways === 0,
        containerOverrides: [
          {
            containerDefinition: taskDef.defaultContainer!,
            environment: [
              { name: 'ORDER_NAME', value: sfn.JsonPath.stringAt('$.orderName') },
              { name: 'JOB', value: sfn.JsonPath.jsonToString(sfn.JsonPath.entirePayload) },
            ],
          },
        ],
        resultPath: sfn.JsonPath.DISCARD,
      });
      step.addRetry({ maxAttempts: 3, interval: Duration.seconds(10), backoffRate: 2 });
      step.addCatch(markFailed, catchProps);
      return step;
    };

    // --- states (status = OrderDesk folder the order sits in) ---
    const markPrinting = updateStatus(this, 'MarkPrinting', jobsTable, orderPk, 'printing');
    const markProofing = updateStatus(this, 'MarkProofing', jobsTable, orderPk, 'proofing');

    const resize = runTask('Resize', 'resize');
    const finish = runTask('Finish', 'finish');
    const proof = runTask('Proof', 'proof');

    // Tell the reviewer a proof is ready (no token; just a ping).
    const notifyProofReady = new tasks.SqsSendMessage(this, 'NotifyProofReady', {
      queue: notifyQueue,
      messageGroupId: 'notify',
      messageBody: sfn.TaskInput.fromObject({
        type: 'proof-ready',
        orderName: sfn.JsonPath.stringAt('$.orderName'),
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Pause for human approval: the request-approval Lambda stores the task
    // token against the order; the approval API later resumes via
    // SendTaskSuccess (approve) or SendTaskFailure (reject -> caught below).
    const requestApproval = new lambda.Function(this, 'RequestApproval', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'src', 'functions', 'request-approval')),
      memorySize: 128,
      timeout: Duration.seconds(30),
      environment: { JOBS_TABLE: jobsTable.tableName },
      description: 'Persist the proof-approval task token for the order',
    });
    jobsTable.grantWriteData(requestApproval);

    const waitForApproval = new tasks.LambdaInvoke(this, 'WaitForApproval', {
      lambdaFunction: requestApproval,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        orderName: sfn.JsonPath.stringAt('$.orderName'),
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });
    waitForApproval.addCatch(markFailed, catchProps);

    // Deliver to the facility: run the ftp container (FTP for GA/NJ/TX/NV,
    // Google Drive for CA). Synchronous like the other stages, so pickup status
    // is only set after a successful transfer; failures are caught -> MarkFailed.
    const transfer = runTask('Transfer', 'ftp');

    const notify = new tasks.SqsSendMessage(this, 'Notify', {
      queue: notifyQueue,
      messageGroupId: 'notify',
      messageBody: sfn.TaskInput.fromObject({
        type: 'order-complete',
        orderName: sfn.JsonPath.stringAt('$.orderName'),
        facility: sfn.JsonPath.stringAt('$.routing.facility'),
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    // After files reach the facility, the order rests in "Awaiting Pickup (XX)"
    // — the facility folder, computed per order (pickup_ga/nj/tx/ca). Staff
    // move it to Completed manually once the facility finishes. UNROUTED orders
    // land in "Awaiting Admin Process" for manual assignment.
    const markPickup = updateStatus(this, 'MarkPickup', jobsTable, orderPk, '$.routing.pickupStatus');
    const markHeld = updateStatus(this, 'MarkHeld', jobsTable, orderPk, 'awaiting_admin');

    // Route: only ship when a transport (facility) was resolved.
    const route = new sfn.Choice(this, 'RouteChoice')
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.routing.transport'),
          sfn.Condition.isNotNull('$.routing.transport'),
        ),
        transfer.next(notify).next(markPickup),
      )
      .otherwise(markHeld);

    const needsProof = new sfn.Choice(this, 'NeedsProof')
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.needsProof'),
          sfn.Condition.booleanEquals('$.needsProof', true),
        ),
        // proof made -> "Proofing" folder -> ping reviewer -> wait for approval
        proof.next(markProofing).next(notifyProofReady).next(waitForApproval).next(route),
      )
      .otherwise(route);

    // Pipeline picks the order up from "In Queue" -> "Printing" while it runs.
    const definition = markPrinting.next(resize).next(finish).next(needsProof);

    this.stateMachine = new sfn.StateMachine(this, 'Pipeline', {
      stateMachineName: `${config.prefix}-pipeline`,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.days(7), // generous: covers the human proof wait
      // Observability (Week 9): X-Ray tracing + error-level execution logs.
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'PipelineLogs', {
          logGroupName: `/sb/${config.env}/states/pipeline`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ERROR,
        includeExecutionData: true,
      },
    });

    // --- trigger: intake.fifo -> starter Lambda -> StartExecution ---
    this.starter = new lambda.Function(this, 'PipelineStarter', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'src', 'functions', 'pipeline-starter')),
      memorySize: 128,
      timeout: Duration.seconds(30),
      environment: { STATE_MACHINE_ARN: this.stateMachine.stateMachineArn },
      description: 'Start the order pipeline for each intake message',
    });
    this.starter.addEventSource(new SqsEventSource(intakeQueue, { batchSize: 10, reportBatchItemFailures: true }));
    this.stateMachine.grantStartExecution(this.starter);

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      exportName: `${config.prefix}-pipeline-arn`,
    });
  }
}

/**
 * A DynamoUpdateItem that sets `status` AND the GSI1 status key together, so the
 * dashboard's per-folder query always reflects the current stage. `status` may
 * be a literal ('printing') or a JsonPath ('$.routing.pickupStatus') for a
 * facility-specific folder (pickup_ga/nj/tx/ca).
 */
function updateStatus(
  scope: Construct,
  id: string,
  table: dynamodb.ITable,
  orderPk: string,
  status: string,
): tasks.DynamoUpdateItem {
  const isPath = status.startsWith('$');
  const statusVal = tasks.DynamoAttributeValue.fromString(
    isPath ? sfn.JsonPath.stringAt(status) : status,
  );
  const gsiVal = tasks.DynamoAttributeValue.fromString(
    isPath ? sfn.JsonPath.format('STATUS#{}', sfn.JsonPath.stringAt(status)) : `STATUS#${status}`,
  );
  return new tasks.DynamoUpdateItem(scope, id, {
    table,
    key: {
      PK: tasks.DynamoAttributeValue.fromString(orderPk),
      SK: tasks.DynamoAttributeValue.fromString('META'),
    },
    updateExpression: 'SET #s = :s, GSI1PK = :g',
    expressionAttributeNames: { '#s': 'status' },
    expressionAttributeValues: { ':s': statusVal, ':g': gsiVal },
    resultPath: sfn.JsonPath.DISCARD,
  });
}
