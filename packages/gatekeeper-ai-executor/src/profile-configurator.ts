import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type {
  AiExecutorProfileOption,
  AiExecutorProfileConfiguratorRpc,
} from "./configurator/profile-configurator-types.js";
import type { ActiveExecutorProfile } from "./protocol.js";
import { canonicalProfileUrl } from "./resources.js";

@validateRpc()
export class AiExecutorProfileConfigurator
  extends RpcTarget
  implements AiExecutorProfileConfiguratorRpc
{
  constructor(private readonly profile: ActiveExecutorProfile) {
    super();
  }

  async listProfiles(): Promise<AiExecutorProfileOption[]> {
    return [
      {
        value: this.profile.id,
        title: this.profile.label,
        subtitle: this.profile.provider,
        meta: this.profile.model,
      },
    ];
  }

  async resourceUrl(): Promise<string> {
    return canonicalProfileUrl(this.profile.id);
  }
}
