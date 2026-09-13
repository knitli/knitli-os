import type { AdminGatekeeperAppInfo } from '@gadgets/workshop-shared/api';
import type {
  GatekeeperUiFrame,
  GatekeeperVendor,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper';
import { createWorkshopLogger } from '../observability.js';

const logger = createWorkshopLogger('workshop.admin.gatekeeper-apps');

type AdminUiVendor = GatekeeperVendor &
  Required<Pick<GatekeeperVendor, 'startAdminUi'>>;

function safeVendorAdminError(caught: unknown): { message: string } {
  const kind = caught instanceof Error ? 'Error' : caught === null ? 'null' : typeof caught;
  return { message: `Gatekeeper vendor call rejected (${kind}).` };
}

function advertisesAdminUi(
  vendor: Service<GatekeeperVendor>,
  description: VendorDescription,
): vendor is Service<AdminUiVendor> {
  return description.providesAdminUi !== undefined;
}

export class AdminGatekeeperApps {
  constructor(private readonly vendors: ReadonlyMap<string, Service<GatekeeperVendor>>) {}

  async list(): Promise<AdminGatekeeperAppInfo[]> {
    const descriptions = await Promise.all([...this.vendors].map(async ([id, vendor]) => {
      try {
        return { id, vendor, description: await vendor.describe() };
      } catch (error) {
        logger.warn('failed to describe admin gatekeeper app', {
          event: 'gatekeeper.admin.describe.failed', vendorId: id, operation: 'describe',
          error: safeVendorAdminError(error),
        });
        return null;
      }
    }));
    return descriptions.flatMap(entry => {
      if (!entry || !advertisesAdminUi(entry.vendor, entry.description)) return [];
      const providesAdminUi = entry.description.providesAdminUi;
      if (!providesAdminUi) return [];
      const { title, icon } = providesAdminUi;
      return [{ id: entry.id, title, icon }];
    });
  }

  async open(id: string): Promise<GatekeeperUiFrame | null> {
    const vendor = this.vendors.get(id);
    if (!vendor) return null;
    let description: VendorDescription;
    try {
      description = await vendor.describe();
    } catch (error) {
      logger.warn('failed to open admin gatekeeper app', {
        event: 'gatekeeper.admin.open.failed', vendorId: id, operation: 'describe',
        error: safeVendorAdminError(error),
      });
      return null;
    }
    if (!advertisesAdminUi(vendor, description)) return null;
    try {
      return await vendor.startAdminUi({ isAdmin: true });
    } catch (error) {
      logger.warn('failed to open admin gatekeeper app', {
        event: 'gatekeeper.admin.open.failed', vendorId: id, operation: 'startAdminUi',
        error: safeVendorAdminError(error),
      });
      return null;
    }
  }
}
