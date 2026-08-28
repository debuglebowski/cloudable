export * from "./common";
export * from "./domains/machines";
export * from "./domains/agent-protocol";
export * from "./domains/compliance";

export * from "./domains/approvals";
export * from "./domains/archive";
export * from "./domains/elevations";
export * from "./domains/config";

// Domain files (e.g. ./domains/machines) are added additively by feature units as
// each domain lands, and re-exported here with their own `export * from "./domains/<name>";`
// line. Do not remove or rename existing exports.
