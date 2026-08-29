import {
  Autocomplete,
  Field,
  // biome-ignore lint/correctness/noUnusedImports: the configurator JSX transform uses h as its factory.
  h,
  Section,
  type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  AiExecutorProfileConfiguratorRpc,
  AiExecutorProfileConfiguratorValues,
} from "./profile-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.profileId === "string" && values.profileId.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    return segments.length === 2 && segments[0] === "profiles"
      ? { profileId: segments[1] }
      : {};
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render({ values, setValues, ui }) {
    return (
      <Section>
        <Field
          label="AI executor profile"
          description="This binding can use only the selected active profile."
        >
          <Autocomplete
            name="profileId"
            value={values.profileId}
            placeholder="Selected active profile"
            loadOptions={() => ui.listProfiles()}
            onChange={(profileId) => setValues({ profileId })}
          />
        </Field>
      </Section>
    );
  },
} satisfies ConfiguratorUISpec<
  AiExecutorProfileConfiguratorRpc,
  AiExecutorProfileConfiguratorValues
>;
