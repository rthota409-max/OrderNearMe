/**
 * Input & Business Rule Validation Service
 * Enforces strict verification on client and trusted transaction logic.
 * Conforms to OrderNearMe Master Project Specification.
 */

export const MIN_CART_AMOUNT = 15;
export const MAX_JOINER_CART = 500;
export const MAX_GROUP_CART = 1500;
export const MAX_EXTENSIONS_LIMIT = 2;        // Spec Section 17: Maximum 2 extensions
export const EXTENSION_DURATION_MINUTES = 5;  // Spec Section 17: 5 minutes each (+10 mins max)
export const MAX_PENDING_REQUESTS_PER_USER = 3;
export const GROUP_LIFECYCLE_MINUTES = 60;   // Spec Section 19: 60 minutes group duration

/**
 * Validates Order Creation form according to Master Specification.
 */
export function validateOrderForm(form) {
  if (!form || typeof form !== "object") {
    return { valid: false, error: "Invalid order form payload" };
  }

  const category = (form.category || "grocery").trim().toLowerCase();
  if (category !== "grocery") {
    return { valid: false, error: "Only grocery orders (Blinkit, Instamart, Zepto) are supported" };
  }

  const platform = (form.platform || "").trim();
  if (!platform || !["blinkit", "instamart", "zepto"].includes(platform.toLowerCase())) {
    return { valid: false, error: "Valid platform (Blinkit, Instamart, Zepto) is required" };
  }

  // Cart values must be positive
  const myAmount = Number(form.myAmount);
  if (isNaN(myAmount) || !isFinite(myAmount) || myAmount < MIN_CART_AMOUNT) {
    return { valid: false, error: `Creator's cart amount must be at least ₹${MIN_CART_AMOUNT}` };
  }

  // Target cart value must be positive
  const targetAmount = Number(form.targetAmount || 199);
  if (isNaN(targetAmount) || !isFinite(targetAmount) || targetAmount <= 0) {
    return { valid: false, error: "Target cart value must be positive" };
  }
  if (targetAmount < myAmount) {
    return { valid: false, error: "Target cart value must be at least your own estimated cart amount" };
  }

  // Maximum cart value (optional)
  if (form.maximumCartValue !== undefined && form.maximumCartValue !== null && form.maximumCartValue !== "") {
    const maxCart = Number(form.maximumCartValue);
    if (isNaN(maxCart) || !isFinite(maxCart) || maxCart < targetAmount) {
      return { valid: false, error: "Maximum cart value, if supplied, must be at least the target cart value" };
    }
  }

  // Order Type: Immediate vs Scheduled
  const orderType = (form.orderType || "immediate").toLowerCase();
  if (!["immediate", "scheduled"].includes(orderType)) {
    return { valid: false, error: "Order type must be either 'immediate' or 'scheduled'" };
  }

  if (orderType === "scheduled") {
    const scheduledAtMs = Number(form.scheduledAtMs || form.scheduledAt || 0);
    if (isNaN(scheduledAtMs) || scheduledAtMs <= Date.now()) {
      return { valid: false, error: "Scheduled order date and time must be in the future" };
    }
  } else {
    const waitMinutes = Number(form.waitMinutes || 15);
    if (isNaN(waitMinutes) || ![5, 10, 15, 30].includes(waitMinutes)) {
      return { valid: false, error: "Initial waiting duration must be 5, 10, 15, or 30 minutes" };
    }
  }

  const pickupPoint = (form.pickupPoint || "").trim();
  if (!pickupPoint) {
    return { valid: false, error: "Hostel / PG / Handover location is required" };
  }

  return { valid: true };
}

/**
 * Validates a Join Request form according to Master Specification.
 */
export function validateJoinRequest(form, order) {
  if (!form || typeof form !== "object") {
    return { valid: false, error: "Invalid join request payload" };
  }

  if (!order) {
    return { valid: false, error: "Order not found" };
  }

  const amount = Number(form.contributionAmount);
  if (isNaN(amount) || !isFinite(amount) || amount < MIN_CART_AMOUNT) {
    return { valid: false, error: `Estimated cart value must be at least ₹${MIN_CART_AMOUNT}` };
  }
  if (amount > MAX_JOINER_CART) {
    return { valid: false, error: `Maximum cart per requester is ₹${MAX_JOINER_CART}` };
  }

  const itemsList = (form.itemsList || "").trim();
  if (!itemsList || itemsList.length < 2) {
    return { valid: false, error: "Requested products / description must not be empty" };
  }

  if (!form.stockConfirmed) {
    return { valid: false, error: "Please verify that your requested products are in stock on the external platform" };
  }

  // Check if adding this request would breach hard maximumCartValue (if defined)
  const currentAcceptedCart = Number(order.acceptedCartValue ?? order.currentCart ?? order.myAmount ?? 0);
  if (order.maximumCartValue && (currentAcceptedCart + amount > Number(order.maximumCartValue))) {
    return { valid: false, error: `Request exceeds order's maximum cart cap of ₹${order.maximumCartValue}` };
  }

  return { valid: true };
}

/**
 * Checks if accepting a requester triggers the 50% above target warning threshold.
 * Spec Section 11: warningThreshold = targetCartValue * 1.5
 */
export function checkCartWarningThreshold(acceptedCartValue, requesterEstimate, targetCartValue) {
  const current = Number(acceptedCartValue || 0);
  const estimate = Number(requesterEstimate || 0);
  const target = Number(targetCartValue || 199);
  const newCart = current + estimate;
  const warningThreshold = target * 1.5;

  const exceedsThreshold = newCart > warningThreshold;
  const percentAbove = target > 0 ? Math.round(((newCart - target) / target) * 100) : 0;

  return {
    exceedsThreshold,
    newCart,
    target,
    percentAbove,
    warningMessage: exceedsThreshold
      ? `Accepting this requester will make your estimated group cart ${percentAbove}% higher than your target (₹${newCart} vs target ₹${target}).`
      : null
  };
}
