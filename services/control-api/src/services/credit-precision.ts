/**
 * Matches the credit balance and lease columns widened by migration 129.
 * Quantize the charge before computing its refund/true-up so the balance
 * movement, persisted settlement and returned charge use the same amount.
 */
export function roundCreditUsd(amount: number): number {
  return Number(amount.toFixed(8));
}
