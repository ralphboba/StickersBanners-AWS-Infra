// Kai's test lane (2026-10-07): end-to-end runs on real test orders while
// Linh's program keeps running and every write switch stays held.
//
// Kai places a test order in Shopify. OrderDesk puts it in QTS like any other
// order; Kai moves it by hand to "Kai-TEST-QTS". Only orders the poller finds
// in THAT folder are test-lane orders, and for them — and only them — the
// pipeline does everything for real, but to destinations nobody else uses:
//
//   OrderDesk moves   the Kai-TEST-* folders below, never Linh's folders
//   proof email       the order's own email address (Kai's test order)
//   print files       FTP /AWS-TEST/..., CA Drive "AWS-TEST" subfolder
//
// Real orders are untouched by any of this: they never carry testLane, so
// every switch still holds them exactly as before.
//
// TEST_LANE must be "enabled" on the function for any of it to apply (dev
// only; prod never sets it). Exact match, like every other switch.

/** Kai-TEST-QTS: the folder Kai drops a test order into. */
export const TEST_INTAKE_FOLDER_ID = '715303';

/** Folder key (as in ORDERDESK_FOLDERS) -> the Kai-TEST-* folder id. */
export const TEST_FOLDERS = Object.freeze({
  processing: '711436', // Kai-TEST-processed
  proofing: '715304', // Kai-TEST-Proofing
  review: '715305', // Kai-TEST-Pending Review
  manual: '711437', // Kai-TEST-manual
  sales: '711438', // Kai-TEST-sales
  // One folder stands in for all five facilities.
  GA: '715306',
  NJ: '715306',
  TX: '715306',
  NV: '715306',
  CA: '715306',
});

const TEST_FOLDER_IDS = new Set([TEST_INTAKE_FOLDER_ID, ...Object.values(TEST_FOLDERS)]);

/** Is the test lane switched on for this function? Defaults to OFF. */
export function testLaneEnabled(env = process.env) {
  return String(env.TEST_LANE ?? '').trim().toLowerCase() === 'enabled';
}

/** A test-lane job, on a function where the lane is switched on. */
export function isTestLaneJob(job, env = process.env) {
  return testLaneEnabled(env) && job?.testLane === true;
}

/** Is this one of Kai's test folders? A test write may only ever land in one. */
export function isTestFolder(id) {
  return TEST_FOLDER_IDS.has(String(id ?? ''));
}
