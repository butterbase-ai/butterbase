export interface Plan {
  id: string;
  name: string;
  price_cents: number;
  interval: 'month' | 'year';
  features: string[];
  active: boolean;
  created_at: string;
  updated_at?: string;
}

export interface CreatePlanParams {
  name: string;
  priceCents: number;
  interval?: 'month' | 'year';
  features?: string[];
}

export interface Product {
  id: string;
  name: string;
  description?: string;
  price_cents: number;
  currency: string;
  active: boolean;
  metadata: Record<string, string>;
  created_at: string;
  updated_at?: string;
}

export interface CreateProductParams {
  name: string;
  description?: string;
  priceCents: number;
  metadata?: Record<string, string>;
}

export interface Subscription {
  id: string;
  plan_id: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  plan_name: string;
  price_cents: number;
  interval: string;
  features: string[];
}

export interface SubscribeParams {
  planId: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
}

export interface PurchaseParams {
  productId: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface PurchaseResult {
  sessionId: string;
  url: string;
  orderId: string;
}

export interface Order {
  id: string;
  product_id: string;
  amount_cents: number;
  platform_fee_cents: number;
  currency: string;
  status: string;
  created_at: string;
  refunded_at?: string;
  product_name: string;
  product_description?: string;
  metadata?: Record<string, any>;
}

export interface ConnectOnboardParams {
  returnUrl?: string;
  refreshUrl?: string;
}

export interface ConnectOnboardResult {
  accountId: string;
  onboardingUrl: string;
}

export interface ConnectStatus {
  connected: boolean;
  accountId?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
}
