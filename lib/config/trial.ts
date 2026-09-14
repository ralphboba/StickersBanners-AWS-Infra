import { Construct } from 'constructs';

/**
 * Settings for a bounded live trial — the five hours on 2026-09-13 when Linh
 * stops his scanner and this system processes the real orders instead.
 *
 * Everything here defaults to the held state, so a plain `cdk deploy` is the
 * same deploy it has always been and `test/safety-switches.test.ts` keeps
 * passing. Arming is a deploy-time decision (`-c armOrderDeskWrites=true`)
 * rather than an edit to the stack files, for one reason: the trial ends by
 * redeploying without the flags, and that has to be something you can do
 * correctly at the end of a long day. Editing three string literals back to
 * "disabled" under time pressure is how a switch gets left on.
 *
 * The three arming flags are deliberately separate. They gate different
 * blast radii — moving an order, emailing a customer, and putting a file in
 * front of production — and no single flag should ever turn on all three.
 */
export interface TrialConfig {
  /** Arms the OrderDesk folder/tag write (the intake gate's move + the claim). */
  readonly orderDeskWrites: 'enabled' | 'disabled';
  /** Arms the real proof email to the real customer. */
  readonly zendeskSends: 'enabled' | 'disabled';
  /** Arms the transfer that puts print files where production collects them. */
  readonly productionTransfer: 'enabled' | 'disabled';
  /** JSON folder-id redirection, or '' for Linh's real folders. */
  readonly orderDeskFolderIds: string;
  /** Prefix for every remote FTP path, or '' for the real facility layout. */
  readonly ftpBasePath: string;
}

/** Only the exact string "true" arms a switch — never "1", "yes" or "TRUE". */
function armed(scope: Construct, key: string): boolean {
  return scope.node.tryGetContext(key) === 'true' || scope.node.tryGetContext(key) === true;
}

function text(scope: Construct, key: string): string {
  const value = scope.node.tryGetContext(key);
  return typeof value === 'string' ? value.trim() : '';
}

export function trialConfig(scope: Construct): TrialConfig {
  return {
    orderDeskWrites: armed(scope, 'armOrderDeskWrites') ? 'enabled' : 'disabled',
    zendeskSends: armed(scope, 'armZendeskSends') ? 'enabled' : 'disabled',
    productionTransfer: armed(scope, 'armProductionTransfer') ? 'enabled' : 'disabled',
    orderDeskFolderIds: text(scope, 'orderDeskFolderIds'),
    ftpBasePath: text(scope, 'ftpBasePath'),
  };
}

/**
 * Say out loud, at synth time, anything that is not in its held state.
 *
 * A deploy that arms a live switch should never be quiet. This prints before
 * the diff, so the last thing seen before approving is the list of things that
 * will start touching the outside world.
 */
export function describeTrial(trial: TrialConfig): string[] {
  const lines: string[] = [];
  if (trial.orderDeskWrites === 'enabled') lines.push('ORDERDESK_WRITES=enabled — real orders will be moved and re-tagged');
  if (trial.zendeskSends === 'enabled') lines.push('ZENDESK_SENDS=enabled — real customers will be emailed');
  if (trial.productionTransfer === 'enabled') lines.push('PRODUCTION_TRANSFER=enabled — print files will be transferred');
  if (trial.orderDeskFolderIds) lines.push(`OrderDesk folders redirected: ${trial.orderDeskFolderIds}`);
  if (trial.ftpBasePath) lines.push(`FTP paths prefixed with: ${trial.ftpBasePath}`);
  return lines;
}
