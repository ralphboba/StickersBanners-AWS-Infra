import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { getConfig } from '../lib/config/environments';
import { describeTrial, TrialConfig } from '../lib/config/trial';
import { ComputeStack } from '../lib/stacks/compute-stack';
import { EcsStack } from '../lib/stacks/ecs-stack';
import { SchedulerStack } from '../lib/stacks/scheduler-stack';

/**
 * The four things that must not happen before Kai says go live.
 *
 * Kai: "절대로 내가 라이브화 하라고 하기 전까지 일어나지 않는 일들은 일어나면
 * 안된다." Nothing here was enforced by a test, so flipping any switch to
 * "enabled" in the source would have passed CI in silence and shipped on the
 * next deploy. These assert the SYNTHESIZED templates, which is what actually
 * reaches AWS.
 *
 * If one of these fails, that is the point. Do not "fix" the test — either the
 * flip was a mistake, or it is a deliberate go-live and this file is the record
 * of that decision being made.
 */

const env = { account: '123456789012', region: 'us-east-1' };
const config = getConfig('dev');

/** Pull a container/function environment variable out of a synthesized template. */
function envOf(props: { Environment?: { Variables?: Record<string, string> } }) {
  return props.Environment?.Variables ?? {};
}

function computeTemplate(context?: Record<string, unknown>) {
  const app = new cdk.App({ context });
  const deps = new cdk.Stack(app, 'deps', { env });
  const stack = new ComputeStack(app, `${config.prefix}-compute`, {
    env,
    config,
    jobsTable: new dynamodb.Table(deps, 'Jobs', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    }),
    intakeQueue: new sqs.Queue(deps, 'Intake', { fifo: true }),
    notifyQueue: new sqs.Queue(deps, 'Notify', { fifo: true }),
  });
  return Template.fromStack(stack);
}

function ecsTemplate(context?: Record<string, unknown>) {
  const app = new cdk.App({ context });
  const deps = new cdk.Stack(app, 'deps', { env });
  const vpc = new ec2.Vpc(deps, 'Vpc');
  const stack = new EcsStack(app, `${config.prefix}-ecs`, {
    env,
    config,
    vpc,
    taskRole: new iam.Role(deps, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    }),
  });
  return Template.fromStack(stack);
}

function schedulerTemplate() {
  const app = new cdk.App();
  const deps = new cdk.Stack(app, 'deps', { env });
  const fn = (id: string) =>
    new lambda.Function(deps, id, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
    });
  const stack = new SchedulerStack(app, `${config.prefix}-scheduler`, {
    env,
    config,
    pollerFn: fn('Poller'),
    demoFeederFn: fn('DemoFeeder'),
  });
  return Template.fromStack(stack);
}

const HELD: TrialConfig = {
  orderDeskWrites: 'disabled', zendeskSends: 'disabled', productionTransfer: 'disabled',
  orderDeskFolderIds: '', ftpBasePath: '', proofEmailRedirect: '',
};

describe('go-live switches are all off', () => {
  test('ORDERDESK_WRITES is disabled — no real order is moved or re-tagged', () => {
    const fns = Object.values(computeTemplate().findResources('AWS::Lambda::Function'));
    const poller = fns.find((f) => f.Properties.FunctionName === 'sb-dev-poller')!;
    expect(envOf(poller.Properties).ORDERDESK_WRITES).toBe('disabled');
  });

  test('ZENDESK_SENDS is disabled — no customer is emailed', () => {
    const fns = Object.values(computeTemplate().findResources('AWS::Lambda::Function'));
    const notify = fns.find((f) => f.Properties.FunctionName === 'sb-dev-notify-consumer')!;
    expect(envOf(notify.Properties).ZENDESK_SENDS).toBe('disabled');
  });

  test('PRODUCTION_TRANSFER is disabled on every task — nothing reaches a facility', () => {
    // Asserted across ALL task definitions, not just ftp: the variable is set
    // once for every container, and a future service that transfers would
    // otherwise inherit no hold at all.
    const defs = Object.values(ecsTemplate().findResources('AWS::ECS::TaskDefinition'));
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      const vars: Record<string, string> = Object.fromEntries(
        (def.Properties.ContainerDefinitions[0].Environment as { Name: string, Value: string }[])
          .map((e) => [e.Name, e.Value]),
      );
      expect(vars.PRODUCTION_TRANSFER).toBe('disabled');
    }
  });

  test('the real poll schedule is DISABLED — no real order enters on its own', () => {
    const schedules = Object.values(schedulerTemplate().findResources('AWS::Scheduler::Schedule'));
    const poller = schedules.find((s) => s.Properties.Name === 'sb-dev-poller')!;
    expect(poller).toBeDefined();
    expect(poller.Properties.State).toBe('DISABLED');
  });

  test('the schedules that ARE enabled cannot touch a real order', () => {
    // The mirror is read-only and the demo feeder only makes DEMO-* orders, so
    // both are safe to leave running — but only those two.
    const schedules = Object.values(schedulerTemplate().findResources('AWS::Scheduler::Schedule'));
    const enabled = schedules
      .filter((s) => s.Properties.State === 'ENABLED')
      .map((s) => s.Properties.Name)
      .sort();
    expect(enabled).toEqual(['sb-dev-demo-feed', 'sb-dev-mirror-sync']);
  });

  test('prod inherits the same holds — a prod deploy is not a way around this', () => {
    const app = new cdk.App();
    const prod = getConfig('prod');
    const deps = new cdk.Stack(app, 'deps', { env });
    const stack = new ComputeStack(app, `${prod.prefix}-compute`, {
      env,
      config: prod,
      jobsTable: new dynamodb.Table(deps, 'Jobs', {
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      }),
      intakeQueue: new sqs.Queue(deps, 'Intake', { fifo: true }),
      notifyQueue: new sqs.Queue(deps, 'Notify', { fifo: true }),
    });
    const fns = Object.values(Template.fromStack(stack).findResources('AWS::Lambda::Function'));
    const poller = fns.find((f) => f.Properties.FunctionName === 'sb-prod-poller')!;
    const notify = fns.find((f) => f.Properties.FunctionName === 'sb-prod-notify-consumer')!;
    expect(envOf(poller.Properties).ORDERDESK_WRITES).toBe('disabled');
    expect(envOf(notify.Properties).ZENDESK_SENDS).toBe('disabled');
  });
});

/**
 * The bounded live trial (2026-09-13, 16:00-21:00 UTC).
 *
 * Kai asked for five hours where this system really does the work: orders moved
 * into his own OrderDesk folders, real proof emails, print files diverted to a
 * path a person reviews before production sees them. Arming is a deploy-time
 * flag so that ENDING it is a redeploy without the flags, not an edit to three
 * string literals at the end of a long day.
 *
 * What these pin is the thing that would be catastrophic and silent: that a
 * value which merely LOOKS affirmative cannot arm anything.
 */
describe('the trial flags', () => {
  /** The poller's environment from a compute template built with this context. */
  function pollerEnv(context?: Record<string, unknown>) {
    const t = computeTemplate(context);
    const fn = Object.values(t.findResources('AWS::Lambda::Function',
      { Properties: { FunctionName: `${config.prefix}-poller` } }))[0] as any;
    return envOf(fn.Properties);
  }

  test('a plain deploy arms nothing at all', () => {
    const vars = pollerEnv();
    expect(vars.ORDERDESK_WRITES).toBe('disabled');
    expect(vars.ORDERDESK_FOLDER_IDS).toBe('');
  });

  test('only the exact string "true" arms a switch', () => {
    for (const value of ['1', 'yes', 'TRUE', 'True', 'enabled', 'on', '']) {
      expect(pollerEnv({ armOrderDeskWrites: value }).ORDERDESK_WRITES).toBe('disabled');
    }
  });

  test('each flag arms only its own switch', () => {
    const t = computeTemplate({ armOrderDeskWrites: 'true' });
    const notify = Object.values(t.findResources('AWS::Lambda::Function',
      { Properties: { FunctionName: `${config.prefix}-notify-consumer` } }))[0] as any;
    expect(pollerEnv({ armOrderDeskWrites: 'true' }).ORDERDESK_WRITES).toBe('enabled');
    expect(envOf(notify.Properties).ZENDESK_SENDS).toBe('disabled');
  });

  /** The notify-consumer's environment — the only Lambda that emails anyone. */
  function notifyEnv(context?: Record<string, unknown>) {
    const t = computeTemplate(context);
    const fn = Object.values(t.findResources('AWS::Lambda::Function',
      { Properties: { FunctionName: `${config.prefix}-notify-consumer` } }))[0] as any;
    return envOf(fn.Properties);
  }

  // Linh's condition for a full trial day, 2026-09-18: he moves the orders back
  // to QTS afterwards and his program reprocesses them, sending its own proof
  // email, so any customer we mail during a trial is a customer who gets two.

  test('a plain deploy has no redirect — the customer is the recipient', () => {
    expect(notifyEnv().PROOF_EMAIL_REDIRECT).toBe('');
  });

  test('the redirect reaches the notify-consumer verbatim', () => {
    expect(notifyEnv({ proofEmailRedirect: 'tester@stickersbanners.com' })
      .PROOF_EMAIL_REDIRECT).toBe('tester@stickersbanners.com');
  });

  test('the redirect arms nothing on its own', () => {
    // It narrows who is contacted; it can never start contacting anyone.
    const vars = notifyEnv({ proofEmailRedirect: 'tester@stickersbanners.com' });
    expect(vars.ZENDESK_SENDS).toBe('disabled');
  });

  test('describeTrial names the dangerous case, not just the unusual one', () => {
    // During a trial, "no redirect" is the DEFAULT and the risky setting, so
    // silence there would be exactly the wrong way round.
    const armed = describeTrial(
      { ...HELD, zendeskSends: 'enabled' });
    expect(armed.join('\n')).toContain('REAL CUSTOMERS WILL BE EMAILED');

    const redirected = describeTrial(
      { ...HELD, zendeskSends: 'enabled', proofEmailRedirect: 'tester@x.com' });
    expect(redirected.join('\n')).toContain('redirected to tester@x.com');
    expect(redirected.join('\n')).not.toContain('REAL CUSTOMERS');
  });

  test('a held deploy says nothing', () => {
    expect(describeTrial(HELD)).toEqual([]);
  });

  test('the folder redirection reaches the poller verbatim', () => {
    const ids = '{"processing":"711436","manual":"711437","sales":"711438"}';
    expect(pollerEnv({ orderDeskFolderIds: ids }).ORDERDESK_FOLDER_IDS).toBe(ids);
  });

  test('the transfer and its path prefix are independent', () => {
    const held = ecsTemplate({ ftpBasePath: '/AWS-TEST' });
    for (const task of Object.values(held.findResources('AWS::ECS::TaskDefinition')) as any[]) {
      for (const c of task.Properties.ContainerDefinitions) {
        const vars = Object.fromEntries(
          (c.Environment ?? []).map((e: any) => [e.Name, e.Value]));
        // A prefix on its own must NOT arm the transfer; it only says where
        // files would go if it were armed.
        expect(vars.PRODUCTION_TRANSFER).toBe('disabled');
        expect(vars.FTP_BASE_PATH).toBe('/AWS-TEST');
      }
    }
  });

  test('armed, the transfer is enabled on every task', () => {
    const armed = ecsTemplate({ armProductionTransfer: 'true', ftpBasePath: '/AWS-TEST' });
    for (const task of Object.values(armed.findResources('AWS::ECS::TaskDefinition')) as any[]) {
      for (const c of task.Properties.ContainerDefinitions) {
        const vars = Object.fromEntries(
          (c.Environment ?? []).map((e: any) => [e.Name, e.Value]));
        expect(vars.PRODUCTION_TRANSFER).toBe('enabled');
      }
    }
  });
});
