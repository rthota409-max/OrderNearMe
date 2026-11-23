/**
 * Authoritative Bill Reconciliation Service
 * 
 * Reconciles merchandise subtotals, threshold checks, delivery & handling fees,
 * discounts/coupons, and individual member shares with exact penny/rupee zero-residual rounding.
 */

/**
 * Validates and reconciles the entire group bill breakdown.
 * 
 * @param {Array<{ uid: string, name: string, amount: number|string, items?: string }>} members
 * @param {Object} breakdown - Breakdown values entered by host or estimated by system
 * @param {number} [freeDeliveryThreshold=199] - Retailer threshold applying strictly to eligible merchandise
 * @returns {Object} Complete authoritative breakdown and per-member allocations
 */
export function reconcileGroupBill(members, breakdown = {}, freeDeliveryThreshold = 199) {
  if (!Array.isArray(members) || members.length === 0) {
    return {
      merchandiseSubtotal: 0,
      freeDeliveryThreshold: Number(freeDeliveryThreshold) || 199,
      thresholdReached: false,
      amountNeededForFreeDelivery: Number(freeDeliveryThreshold) || 199,
      deliveryFee: 0,
      handlingFee: 0,
      packagingFee: 0,
      surgeFee: 0,
      totalFees: 0,
      discountAmount: 0,
      finalCheckoutTotal: 0,
      isConfirmed: false,
      memberBreakdowns: []
    };
  }

  const N = members.length;

  // 1. Calculate Authoritative Merchandise Subtotal from validated member line items
  // Threshold applies STRICTLY to eligible merchandise, NOT delivery fees or taxes.
  let merchandiseSubtotal = 0;
  const sanitizedMembers = members.map((m) => {
    const rawAmt = Number(m.amount || m.subtotal || 0);
    const validAmt = isNaN(rawAmt) || rawAmt < 0 ? 0 : Math.round(rawAmt);
    merchandiseSubtotal += validAmt;
    return {
      uid: m.uid,
      name: m.name || "Member",
      photo: m.photo || "",
      items: m.items || "",
      merchandiseAmount: validAmt
    };
  });

  const threshold = Math.max(0, Number(freeDeliveryThreshold) || 199);
  const thresholdReached = merchandiseSubtotal >= threshold;
  const amountNeededForFreeDelivery = thresholdReached ? 0 : threshold - merchandiseSubtotal;

  // 2. Fees & Discounts
  // If threshold reached and delivery fee was not explicitly customized by host, default is 0.
  let defaultDelivery = thresholdReached ? 0 : 30;
  if (breakdown.deliveryFee !== undefined && breakdown.deliveryFee !== null && breakdown.deliveryFee !== "") {
    defaultDelivery = Math.max(0, Math.round(Number(breakdown.deliveryFee) || 0));
  }

  const deliveryFee = defaultDelivery;
  const handlingFee = Math.max(0, Math.round(Number(breakdown.handlingFee || 0)));
  const packagingFee = Math.max(0, Math.round(Number(breakdown.packagingFee || 0)));
  const surgeFee = Math.max(0, Math.round(Number(breakdown.surgeFee || 0)));
  const discountAmount = Math.max(0, Math.round(Number(breakdown.discountAmount || 0)));

  const totalFees = deliveryFee + handlingFee + packagingFee + surgeFee;

  // 3. Final Checkout Total
  const finalCheckoutTotal = Math.max(0, merchandiseSubtotal + totalFees - discountAmount);

  // 4. Exact Zero-Residual Per-Member Allocation
  // Net shared adjustment = totalFees - discountAmount
  const netSharedAdjustment = totalFees - discountAmount;

  // Each member's base share of net adjustment:
  const baseShare = Math.floor(netSharedAdjustment / N);
  let remainder = netSharedAdjustment - (baseShare * N);

  // Fee share and discount share for display:
  const baseFeeEach = Math.floor(totalFees / N);
  let feeRemainder = totalFees - (baseFeeEach * N);

  const baseDiscountEach = Math.floor(discountAmount / N);
  let discountRemainder = discountAmount - (baseDiscountEach * N);

  let allocatedSum = 0;

  const memberBreakdowns = sanitizedMembers.map((m, idx) => {
    // Allocate 1 unit of remainder to first `remainder` members to ensure exact sum
    const memberNetAdjustment = baseShare + (idx < remainder ? 1 : 0);
    const memberFeeShare = baseFeeEach + (idx < feeRemainder ? 1 : 0);
    const memberDiscountShare = baseDiscountEach + (idx < discountRemainder ? 1 : 0);

    const finalAmountOwed = Math.max(0, m.merchandiseAmount + memberNetAdjustment);
    allocatedSum += finalAmountOwed;

    return {
      uid: m.uid,
      name: m.name,
      photo: m.photo,
      items: m.items,
      merchandiseAmount: m.merchandiseAmount,
      feeShare: memberFeeShare,
      discountShare: memberDiscountShare,
      netAdjustmentShare: memberNetAdjustment,
      finalAmountOwed
    };
  });

  // Guarantee invariant: Sum of individual contributions MUST EXACTLY equal finalCheckoutTotal
  const residual = finalCheckoutTotal - allocatedSum;
  if (residual !== 0 && memberBreakdowns.length > 0) {
    // Absorb any edge residual into host (index 0) or first member
    memberBreakdowns[0].finalAmountOwed += residual;
    allocatedSum += residual;
  }

  return {
    merchandiseSubtotal,
    freeDeliveryThreshold: threshold,
    thresholdReached,
    amountNeededForFreeDelivery,
    deliveryFee,
    handlingFee,
    packagingFee,
    surgeFee,
    totalFees,
    discountAmount,
    finalCheckoutTotal,
    isConfirmed: !!breakdown.isConfirmed,
    memberBreakdowns
  };
}
