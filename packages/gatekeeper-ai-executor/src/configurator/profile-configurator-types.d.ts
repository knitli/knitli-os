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
  /** Returns only the bound profile's canonical resource URL. */
  resourceUrl(): Promise<string>;
}
