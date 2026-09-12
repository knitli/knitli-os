// Moved to backend-utils so gatekeeper Workers can verify the same Access assertion the Workshop
// does (fork). Re-exported here so nothing in this package changes its import.
export {
  accessRateLimitKey,
  verifyCfAccessJwt,
  type CfAccessEnv,
} from "@gadgets/backend-utils/access";
