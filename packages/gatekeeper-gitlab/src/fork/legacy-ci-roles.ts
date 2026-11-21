// Fork-owned: the roles earlier releases required for CI data a workspace has already read.
//
// Those releases recorded a role, not a job: reads reported `project/<id>/role/developer` or
// `.../role/maintainer`, and the reads before them marked the binding `ci-logs` or
// `ci-test-reports`. Reads now name each job (see project-subresources.ts), but nothing rewrites
// what a workspace recorded then, and the data it read then may still be in it: a debug job log
// carries every CI/CD variable. So a recorded role is still required of an observer.

/** GitLab's access level for each role a recorded ID can name. */
const ROLE_ACCESS_LEVELS: Record<string, number> = { developer: 30, maintainer: 40 };

/** GitLab's access level for each CI-data set a binding can be marked with. */
const CI_SET_ACCESS_LEVELS: Record<string, number> = {
  "ci-logs": ROLE_ACCESS_LEVELS.developer,
  "ci-test-reports": ROLE_ACCESS_LEVELS.maintainer,
};

/** The access level the role in a recorded `project/<id>/role/<role>` ID needs; undefined for any other role. */
export function legacyRoleAccessLevel(role: string): number | undefined {
  return Object.hasOwn(ROLE_ACCESS_LEVELS, role) ? ROLE_ACCESS_LEVELS[role] : undefined;
}

/** The access level a marked CI-data set needs; undefined for a set no release marked. */
export function legacyCiSetAccessLevel(setId: string): number | undefined {
  return Object.hasOwn(CI_SET_ACCESS_LEVELS, setId) ? CI_SET_ACCESS_LEVELS[setId] : undefined;
}

/** What an observer below a marked set's role is told. */
export function legacyCiSetDenyMessage(setId: string): string {
  return setId === "ci-test-reports"
    ? "This workspace has read CI test reports from this GitLab project that GitLab may show only " +
      "to members with the Maintainer role or above, so this collaborator cannot be allowed to observe them."
    : "This workspace has read CI job logs or test reports from this GitLab project that GitLab " +
      "may show only to members with the Developer role or above, so this collaborator cannot be " +
      "allowed to observe them.";
}
