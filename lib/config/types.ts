/**
 * Shared configuration types for the StickersBanners AWS infrastructure.
 *
 * Every stack receives an `EnvironmentConfig` so that the same constructs can be
 * synthesized for `dev` and `prod` with environment-appropriate sizing and
 * safety settings (e.g. NAT Gateway count, removal policies).
 */

export type DeployEnv = 'dev' | 'prod';

export interface NetworkConfig {
  /** CIDR block for the VPC. dev/prod use distinct ranges to allow peering later. */
  readonly cidr: string;
  /** Number of Availability Zones to spread subnets across. */
  readonly maxAzs: number;
  /**
   * Number of NAT Gateways. 1 is cheaper (dev), one-per-AZ is HA (prod).
   */
  readonly natGateways: number;
}

export interface EnvironmentConfig {
  /** Logical environment name. */
  readonly env: DeployEnv;
  /** AWS account id. Falls back to CDK_DEFAULT_ACCOUNT when undefined. */
  readonly account?: string;
  /** AWS region. */
  readonly region: string;
  /** Resource name prefix, e.g. "sb-dev". */
  readonly prefix: string;
  /** Network/VPC settings. */
  readonly network: NetworkConfig;
  /** Tags applied to every resource in the environment. */
  readonly tags: Record<string, string>;
  /**
   * Whether the real intake poll (`<prefix>-poller`) runs on its schedule.
   * Off unless set. On, real QTS orders enter the pipeline; what they can then
   * touch outside it is still decided by the switches in `trial.ts`.
   */
  readonly intakePollEnabled?: boolean;
  /**
   * Kai's test lane (src/shared/test-lane.mjs): orders Kai moves to the
   * Kai-TEST-QTS folder run for real — OrderDesk moves between the Kai-TEST-*
   * folders, the proof email to the order's own address, print files to FTP
   * /AWS-TEST and the CA Drive "AWS-TEST" folder — while every write switch
   * keeps holding real orders. Off unless set; never set for prod.
   */
  readonly testLaneEnabled?: boolean;
}
