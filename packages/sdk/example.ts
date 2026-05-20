import { createClient } from '@butterbase/sdk';

// Example usage of the Butterbase SDK
async function main() {
  // Initialize client
  const butterbase = createClient({
    appId: 'app_example123',
    apiUrl: 'http://localhost:4000',
    anonKey: 'anon_key_example',
  });

  console.log('✓ Client created successfully');

  // Example: Query builder
  console.log('\n--- Query Builder Example ---');
  const query = butterbase
    .from('posts')
    .select('id,title,status')
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .limit(10);

  console.log('✓ Query builder chain created');

  // Example: Insert
  console.log('\n--- Insert Example ---');
  const insertBuilder = butterbase
    .from('posts')
    .insert({ title: 'Test Post', content: 'Hello World' });

  console.log('✓ Insert builder created');

  // Example: Update
  console.log('\n--- Update Example ---');
  const updateBuilder = butterbase
    .from('posts')
    .update({ status: 'archived' })
    .eq('id', '123');

  console.log('✓ Update builder created');

  // Example: Delete
  console.log('\n--- Delete Example ---');
  const deleteBuilder = butterbase
    .from('posts')
    .delete()
    .eq('id', '123');

  console.log('✓ Delete builder created');

  // Example: Auth
  console.log('\n--- Auth Example ---');
  console.log('Auth client available:', !!butterbase.auth);
  console.log('Methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(butterbase.auth)));

  // Example: Storage
  console.log('\n--- Storage Example ---');
  console.log('Storage client available:', !!butterbase.storage);
  console.log('Methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(butterbase.storage)));

  // Example: Functions
  console.log('\n--- Functions Example ---');
  console.log('Functions client available:', !!butterbase.functions);
  console.log('Methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(butterbase.functions)));

  console.log('\n✅ All SDK components initialized successfully!');
}

main().catch(console.error);
