import { findProduct, loadCatalog, loadUsers, preferencesOf } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";
import { userIdFrom } from "@/lib/backend/request";
import type { FulfillmentOption } from "@/lib/backend/types";

const FREE_SHIPPING_OVER = 49;
const FREIGHT_CATEGORIES = new Set(["office-electronics", "fitness"]);
const FREIGHT_PRICE_FLOOR = 350;

/** A simplified stand-in for `MockRetail._pickup_eta`'s store-hours math (reference
 * skipped for this embedded backend — see `lib/backend/catalog.ts`'s docstring on
 * deliberately-not-ported flourishes): before 5pm local, ready today; otherwise
 * tomorrow morning. */
function pickupEta(): string {
  return new Date().getHours() < 17 ? "today by 6 PM" : "tomorrow morning";
}

export async function POST(req: Request) {
  try {
    const { product_ids } = (await req.json()) as { product_ids: string[] };
    const catalog = await loadCatalog();
    const users = await loadUsers();
    const preferences = preferencesOf(users, userIdFrom(req));
    const location = preferences.default_location ?? "your area";
    const quoted = product_ids.map((id) => findProduct(catalog, id)).filter((p): p is NonNullable<typeof p> => !!p);

    const standardFee = quoted.reduce((sum, p) => sum + p.price, 0) > FREE_SHIPPING_OVER ? 0 : 5.99;
    const options: FulfillmentOption[] = [
      { method: "delivery", eta: "3-5 business days (standard)", fee: standardFee },
      { method: "delivery", eta: "2 business days (express)", fee: 9.99 },
      { method: "pickup", eta: pickupEta(), fee: 0, location: `ACME ${location}` },
    ];
    if (quoted.some((p) => FREIGHT_CATEGORIES.has(p.category ?? "") && p.price > FREIGHT_PRICE_FLOOR)) {
      options.push({ method: "shipping", eta: "5-7 business days (freight)", fee: 29.0 });
    }
    return Response.json({ options });
  } catch (err) {
    return errorResponse(err);
  }
}
