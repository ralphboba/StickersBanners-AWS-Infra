import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface GithubOidcStackProps extends cdk.StackProps {
  /** GitHub repository in "owner/name" form that is allowed to assume the role. */
  readonly githubRepo: string;
  /**
   * Reuse an existing GitHub OIDC provider instead of creating one.
   *
   * AWS allows only ONE identity provider per URL per account. If the account
   * already trusts token.actions.githubusercontent.com (e.g. another project
   * set it up), set this to true so we import it instead of failing to create
   * a duplicate.
   */
  readonly useExistingProvider?: boolean;
}

/**
 * Account-level trust between GitHub Actions and AWS via OpenID Connect (OIDC).
 *
 * This is deployed ONCE per AWS account (not per dev/prod). It creates:
 *  - An IAM OIDC identity provider for token.actions.githubusercontent.com.
 *  - An IAM role that GitHub Actions can assume — but only from this repo —
 *    to receive short-lived (≈1h) credentials. No long-lived access keys are
 *    ever stored in GitHub.
 *
 * The role can assume the CDK bootstrap roles, which is all `cdk diff`/`cdk
 * deploy` need. CI (diff) and humans (deploy) both go through these roles.
 */
export class GithubOidcStack extends cdk.Stack {
  public readonly role: iam.IRole;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const githubDomain = 'token.actions.githubusercontent.com';

    const provider: iam.IOpenIdConnectProvider = props.useExistingProvider
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GithubOidcProvider',
          `arn:aws:iam::${this.account}:oidc-provider/${githubDomain}`,
        )
      : new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
          url: `https://${githubDomain}`,
          // GitHub's OIDC audience for the AWS credential action.
          clientIds: ['sts.amazonaws.com'],
        });

    // Trust policy: only GitHub Actions runs from THIS repo may assume the role.
    // `aud` pins the audience; `sub` is restricted to the repo (any branch/PR).
    const principal = new iam.OpenIdConnectPrincipal(provider, {
      StringEquals: {
        [`${githubDomain}:aud`]: 'sts.amazonaws.com',
      },
      StringLike: {
        [`${githubDomain}:sub`]: `repo:${props.githubRepo}:*`,
      },
    });

    const role = new iam.Role(this, 'GithubActionsRole', {
      roleName: 'sb-github-actions-cdk',
      assumedBy: principal,
      description: `GitHub Actions CDK role for ${props.githubRepo} (assumed via OIDC)`,
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // CDK performs all account operations through its bootstrap roles
    // (cdk-<qualifier>-{deploy,lookup,file-publishing,...}). Granting permission
    // to assume those roles is sufficient for both `cdk diff` and `cdk deploy`,
    // and keeps this role itself minimally privileged.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
        conditions: {
          StringEquals: { 'aws:ResourceTag/aws-cdk:bootstrap-role': ['deploy', 'lookup', 'file-publishing', 'image-publishing'] },
        },
      }),
    );

    this.role = role;

    new cdk.CfnOutput(this, 'GithubActionsRoleArn', {
      value: role.roleArn,
      description: 'Set this as the AWS_ROLE_ARN secret/variable in GitHub.',
      exportName: 'sb-github-actions-role-arn',
    });
  }
}
