export interface PartnerListItem {
  slug: string;
  display_name: string;
  description: string | null;
  docs_url: string | null;
  proxy_url_template: string;
  contact_message: string;
  status: 'available' | 'exhausted';
}

export interface PartnerListResponse {
  partners: PartnerListItem[];
}
