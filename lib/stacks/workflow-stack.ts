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

    const { config, cluster, vpc, securityGroup, taskDefinitions, jobsTable, ftpQueue, notifyQueue, intakeQueue } =
      props;

    const orderPk = sfn.JsonPath.format('ORDER#{}', sfn.JsonPath.stringAt('$.orderName'));

    // --- failure handling (shared catch target) ---
    const markFailed = new tasks.DynamoUpdateItem(this, 'MarkFailed', {
      table: jobsTable,
      key: {
        PK: tasks.DynamoAttributeValue.fromString(orderPk),
        SK: tasks.DynamoAttributeValue.fromString('META'),
      },
      updateExpression: 'SET #s = :s',
      expressionAttributeNames: { '#s': 'status' },
      expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('failed') },
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
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [securityGroup],
        assignPublicIp: false,
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

    // --- states ---
    const markProcessing = updateStatus(this, 'MarkProcessing', jobsTable, orderPk, 'processing', true);

    const resize = runTask('Resize', 'resize');
    const finish = runTask('Finish', 'finish');
    const proof = runTask('Proof', 'proof');

    const waitForApproval = new tasks.SqsSendMessage(this, 'WaitForApproval', {
      queue: notifyQueue,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      messageGroupId: 'approval',
      messageBody: sfn.TaskInput.fromObject({
        type: 'proof-approval',
        orderName: sfn.JsonPath.stringAt('$.orderName'),
        taskToken: sfn.JsonPath.taskToken,
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });
    waitForApproval.addCatch(markFailed, catchProps);

    const sendToTransfer = new tasks.SqsSendMessage(this, 'SendToTransfer', {
      queue: ftpQueue,
      messageGroupId: 'transfer',
      messageBody: sfn.TaskInput.fromJsonPathAt('$'),
      resultPath: sfn.JsonPath.DISCARD,
    });
    sendToTransfer.addCatch(markFailed, catchProps);

    const notify = new tasks.SqsSendMessage(this, 'Notify', {
      queue: notifyQueue,
      messageGroupId: 'notify',
      messageBody: sfn.TaskInput.fromObject({
        type: 'order-complete',
        orderName: sfn.JsonPath.stringAt('$.orderName'),
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    const markDone = updateStatus(this, 'MarkDone', jobsTable, orderPk, 'done', false);
    const markHeld = updateStatus(this, 'MarkHeld', jobsTable, orderPk, 'manual_hold', false);

    // Route: only ship when a transport (facility) was resolved.
    const route = new sfn.Choice(this, 'RouteChoice')
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.routing.transport'),
          sfn.Condition.isNotNull('$.routing.transport'),
        ),
        sendToTransfer.next(notify).next(markDone),
      )
      .otherwise(markHeld);

    const needsProof = new sfn.Choice(this, 'NeedsProof')
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.needsProof'),
          sfn.Condition.booleanEquals('$.needsProof', true),
        ),
        proof.next(waitForApproval).next(route),
      )
      .otherwise(route);

    const definition = markProcessing.next(resize).next(finish).next(needsProof);

    this.stateMachine = new sfn.StateMachine(this, 'Pipeline', {
      stateMachineName: `${config.prefix}-pipeline`,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.days(7), // generous: covers the human proof wait
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

/** A DynamoUpdateItem that sets status (and optionally the GSI1 status key). */
function updateStatus(
  scope: Construct,
  id: string,
  table: dynamodb.ITable,
  orderPk: string,
  status: string,
  withGsi: boolean,
): tasks.DynamoUpdateItem {
  const values: Record<string, tasks.DynamoAttributeValue> = {
    ':s': tasks.DynamoAttributeValue.fromString(status),
  };
  let updateExpression = 'SET #s = :s';
  if (withGsi) {
    updateExpression += ', GSI1PK = :g';
    values[':g'] = tasks.DynamoAttributeValue.fromString(`STATUS#${status}`);
  }
  return new tasks.DynamoUpdateItem(scope, id, {
    table,
    key: {
      PK: tasks.DynamoAttributeValue.fromString(orderPk),
      SK: tasks.DynamoAttributeValue.fromString('META'),
    },
    updateExpression,
    expressionAttributeNames: { '#s': 'status' },
    expressionAttributeValues: values,
    resultPath: sfn.JsonPath.DISCARD,
  });
}
