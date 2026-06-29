import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as budgets from 'aws-cdk-lib/aws-budgets';

export interface BillingStackProps extends cdk.StackProps {
  /** Email address that receives budget alerts. */
  readonly alertEmail: string;
  /**
   * Monthly cost ceiling in USD. Kept intentionally low so any unexpected
   * charge (e.g. an accidentally-deployed NAT Gateway) triggers an alert early.
   */
  readonly monthlyLimitUsd: number;
}

/**
 * Account-wide cost guardrail.
 *
 * Creates a single monthly AWS Budget (free — the account's first two budgets
 * carry no charge) that emails the owner when *actual* or *forecasted* spend
 * crosses a fraction of the limit. The goal is "nothing leaves AWS unnoticed":
 * because the steady-state footprint is ~$0 (IAM/OIDC/empty buckets), even a
 * few dollars of real spend is worth surfacing immediately.
 */
export class BillingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, props);

    const subscribers: budgets.CfnBudget.SubscriberProperty[] = [
      { subscriptionType: 'EMAIL', address: props.alertEmail },
    ];

    new budgets.CfnBudget(this, 'MonthlyCostBudget', {
      budget: {
        budgetName: 'sb-monthly-cost-guardrail',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: props.monthlyLimitUsd,
          unit: 'USD',
        },
      },
      // Alert early: at 1% (≈ the moment any real charge appears), 50%, 80%,
      // and when spend is forecast to exceed the limit.
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 1,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 50,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
      ],
    });

    new cdk.CfnOutput(this, 'BudgetName', {
      value: 'sb-monthly-cost-guardrail',
      description: `Monthly budget alerting ${props.alertEmail} at $${props.monthlyLimitUsd} USD.`,
    });
  }
}
