import { RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorContract,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import PROFILE_CONFIGURATOR_HTML from "./generated/profile-configurator-ui.txt";
import type { InferenceRuntime } from "./protocol.js";
import {
  parseActiveProfiles,
  parseProfileResourceUrl,
  resolveActiveProfileResource,
  supportedResourceForProfile,
} from "./resources.js";
import { AiExecutorProfileConfigurator } from "./profile-configurator.js";
import type {
  AiExecutorGatekeeperImpl,
  AiExecutorGatekeeperProps,
} from "./ai-executor.js";
import type { AiExecutor } from "./types.js";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env & { AI_INFERENCE_RUNTIME: InferenceRuntime };
const KNITLI_AVATAR = { url: "https://knitli.com/favicon.svg" };
type ExecutorExports = {
  AiExecutorAccount(options: {
    props: Record<string, never>;
  }): Fetcher<AiExecutorAccount>;
  AiExecutorVerifier(options: {
    props: Record<string, never>;
  }): Fetcher<AiExecutorVerifier>;
  AiExecutorGatekeeperImpl(options: {
    props: AiExecutorGatekeeperProps;
  }): DurableObjectClass<AiExecutorGatekeeperImpl>;
};

async function resources(
  runtime: InferenceRuntime,
): Promise<SupportedResource[]> {
  return (await parseActiveProfiles(runtime)).map(supportedResourceForProfile);
}

@validateRpc()
export class GatekeeperVendor
  extends WorkerEntrypoint<Env>
  implements GatekeeperVendorContract
{
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Knitli AI",
      url: "https://knitli.com/",
      tagline: "Use administrator-curated AI executor profiles",
      description:
        "Run approval-aware inference through active profiles curated by your administrator.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error(
      "Knitli AI is auto-provisioned and has no connection flow.",
    );
  }

  async getSupportedResources(_options?: {
    userId?: string;
  }): Promise<SupportedResource[]> {
    return resources(this.env.AI_INFERENCE_RUNTIME);
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    const exports = this.ctx.exports as unknown as ExecutorExports;
    return exports.AiExecutorAccount({
      props: {},
    }) as unknown as Fetcher<GatekeeperUser>;
  }
}

@validateRpc()
export class AiExecutorAccount
  extends WorkerEntrypoint<Env, Record<string, never>>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return { displayName: "Knitli AI", avatar: KNITLI_AVATAR };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return resources(this.env.AI_INFERENCE_RUNTIME);
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<AiExecutor>>;
    resource: SupportedResource;
  }> {
    const profile = await resolveActiveProfileResource(
      this.env.AI_INFERENCE_RUNTIME,
      url,
    );
    const profileId = profile.id;
    const exports = this.ctx.exports as unknown as ExecutorExports;
    return {
      class: exports.AiExecutorGatekeeperImpl({
        props: { profileId },
      }) as unknown as DurableObjectClass<Gatekeeper<AiExecutor>>,
      resource: supportedResourceForProfile(profile),
    };
  }

  async startResourceConfigurator(
    resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame> {
    const profile = await resolveActiveProfileResource(
      this.env.AI_INFERENCE_RUNTIME,
      resourceUrlPattern,
    );
    return {
      iframeHtml: PROFILE_CONFIGURATOR_HTML,
      ui: new RpcStub(new AiExecutorProfileConfigurator(profile)),
    };
  }

  async ensureResources(
    resourceUrlPatterns: string[],
  ): Promise<{ url?: string }> {
    const active = await parseActiveProfiles(this.env.AI_INFERENCE_RUNTIME);
    const activeIds = new Set(active.map((profile) => profile.id));
    for (const pattern of resourceUrlPatterns) {
      if (!activeIds.has(parseProfileResourceUrl(pattern))) {
        throw new Error("AI executor profile is not active.");
      }
    }
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Knitli AI is auto-provisioned and has no reconnect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const exports = this.ctx.exports as unknown as ExecutorExports;
    return exports.AiExecutorVerifier({ props: {} });
  }
}

@validateRpc()
export class AiExecutorVerifier
  extends WorkerEntrypoint<Env, Record<string, never>>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}
