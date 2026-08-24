export type AiExecutorProfileConfiguratorValues = {
  profileId?: string | null;
};

export type AiExecutorProfileOption = {
  value: string;
  title: string;
  subtitle: string;
  meta: string;
};

export interface AiExecutorProfileConfiguratorRpc {
  /** Lists the single active profile selected for this resource. */
  listProfiles(): Promise<AiExecutorProfileOption[]>;
  /** Returns only the selected profile's canonical resource URL. */
  resourceUrl(profileId: string): Promise<string>;
}
