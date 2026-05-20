import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type {
  Plan, CreatePlanParams, Product, CreateProductParams,
  Subscription, SubscribeParams, CheckoutSession, PurchaseParams, PurchaseResult,
  Order, ConnectOnboardResult, ConnectStatus,
} from './types.js';

export class BillingClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  // ── Admin methods (require platform auth) ──

  async connectOnboard(): Promise<ButterbaseResponse<ConnectOnboardResult>> {
    try {
      const data = await this.client.request<ConnectOnboardResult>(
        'POST', `/v1/${this.client.appId}/billing/connect/onboard`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async connectStatus(): Promise<ButterbaseResponse<ConnectStatus>> {
    try {
      const data = await this.client.request<ConnectStatus>(
        'GET', `/v1/${this.client.appId}/billing/connect/status`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async createPlan(params: CreatePlanParams): Promise<ButterbaseResponse<Plan>> {
    try {
      const data = await this.client.request<Plan>(
        'POST', `/v1/${this.client.appId}/billing/plans`, params
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async updatePlan(planId: string, updates: Partial<CreatePlanParams> & { active?: boolean }): Promise<ButterbaseResponse<Plan>> {
    try {
      const data = await this.client.request<Plan>(
        'PUT', `/v1/${this.client.appId}/billing/plans/${planId}`, updates
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async createProduct(params: CreateProductParams): Promise<ButterbaseResponse<Product>> {
    try {
      const data = await this.client.request<Product>(
        'POST', `/v1/${this.client.appId}/billing/products`, params
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async updateProduct(productId: string, updates: Partial<CreateProductParams> & { active?: boolean }): Promise<ButterbaseResponse<Product>> {
    try {
      const data = await this.client.request<Product>(
        'PUT', `/v1/${this.client.appId}/billing/products/${productId}`, updates
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  // ── Client methods (end-user auth) ──

  async listPlans(): Promise<ButterbaseResponse<Plan[]>> {
    try {
      const data = await this.client.request<{ plans: Plan[] }>(
        'GET', `/v1/${this.client.appId}/billing/plans`
      );
      return { data: data.plans, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async listProducts(): Promise<ButterbaseResponse<Product[]>> {
    try {
      const data = await this.client.request<{ products: Product[] }>(
        'GET', `/v1/${this.client.appId}/billing/products`
      );
      return { data: data.products, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async subscribe(params: SubscribeParams): Promise<ButterbaseResponse<CheckoutSession>> {
    try {
      const data = await this.client.request<CheckoutSession>(
        'POST', `/v1/${this.client.appId}/billing/subscribe`, params
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getSubscription(): Promise<ButterbaseResponse<Subscription | null>> {
    try {
      const data = await this.client.request<{ subscription: Subscription | null }>(
        'GET', `/v1/${this.client.appId}/billing/subscription`
      );
      return { data: data.subscription, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async cancel(): Promise<ButterbaseResponse<{ message: string }>> {
    try {
      const data = await this.client.request<{ message: string }>(
        'POST', `/v1/${this.client.appId}/billing/cancel`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async purchase(params: PurchaseParams): Promise<ButterbaseResponse<PurchaseResult>> {
    try {
      const data = await this.client.request<PurchaseResult>(
        'POST', `/v1/${this.client.appId}/billing/purchase`, params
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async listOrders(): Promise<ButterbaseResponse<Order[]>> {
    try {
      const data = await this.client.request<{ orders: Order[] }>(
        'GET', `/v1/${this.client.appId}/billing/orders`
      );
      return { data: data.orders, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getOrder(orderId: string): Promise<ButterbaseResponse<Order>> {
    try {
      const data = await this.client.request<Order>(
        'GET', `/v1/${this.client.appId}/billing/orders/${orderId}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
