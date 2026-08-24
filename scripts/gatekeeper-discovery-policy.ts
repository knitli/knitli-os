const GATEKEEPER_PREFIX = "gatekeeper-";
const OUTER_DEPLOYMENT_ONLY = new Set(["gatekeeper-ai-executor"]);

export function isGatekeeperPackage(packageName: string): boolean {
  return packageName.startsWith(GATEKEEPER_PREFIX);
}

export function isStandaloneGatekeeperPackage(packageName: string): boolean {
  return (
    isGatekeeperPackage(packageName) && !OUTER_DEPLOYMENT_ONLY.has(packageName)
  );
}
