export interface Field {
  key: string;
  type: string;
  required: boolean;
  display: 'primary' | 'detail' | 'private';
  label: string;
  options?: string[];
}

export interface FieldSchema {
  fields: Field[];
}
