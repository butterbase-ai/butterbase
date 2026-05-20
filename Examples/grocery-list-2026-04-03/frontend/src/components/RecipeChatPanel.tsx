import { useState, type FormEvent } from 'react';
import type { RecipeChatMessage } from '../types';
import { sendRecipeChat } from '../services/recipeChat';

interface RecipeChatPanelProps {
  token: string | null;
}

export function RecipeChatPanel({ token }: RecipeChatPanelProps) {
  const [messages, setMessages] = useState<RecipeChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !input.trim() || loading) return;

    const userContent = input.trim();
    setInput('');
    setError('');

    const previous = messages;
    const nextHistory: RecipeChatMessage[] = [
      ...previous,
      { role: 'user', content: userContent },
    ];
    setMessages(nextHistory);
    setLoading(true);

    try {
      const { reply } = await sendRecipeChat(token, nextHistory);
      setMessages([...nextHistory, { role: 'assistant', content: reply }]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setError(message);
      setMessages(previous);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      style={{
        marginTop: '32px',
        padding: '20px',
        border: '1px solid #ccc',
        borderRadius: '8px',
        backgroundColor: '#fafafa',
      }}
    >
      <h2 style={{ marginTop: 0 }}>Recipe assistant</h2>
      <p style={{ color: '#555', fontSize: '14px', marginBottom: '16px' }}>
        Ask for meal ideas based on your list. The assistant sees your current items (including what you
        still need vs already have) and can suggest what to add plus a recipe.
      </p>

      {error && (
        <div
          style={{
            color: '#b00020',
            marginBottom: '12px',
            padding: '10px',
            backgroundColor: '#ffebee',
            fontSize: '14px',
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          maxHeight: '320px',
          overflowY: 'auto',
          marginBottom: '12px',
          padding: '12px',
          backgroundColor: '#fff',
          border: '1px solid #e0e0e0',
          borderRadius: '4px',
        }}
      >
        {messages.length === 0 ? (
          <div style={{ color: '#888', fontSize: '14px' }}>
            Example: &quot;I have pasta and tomatoes — what else do I need for a simple dinner?&quot;
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={`${m.role}-${i}`}
              style={{
                marginBottom: '12px',
                padding: '8px',
                backgroundColor: m.role === 'user' ? '#e3f2fd' : '#f5f5f5',
                borderRadius: '4px',
              }}
            >
              <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>
                {m.role === 'user' ? 'You' : 'Assistant'}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: '14px' }}>{m.content}</div>
            </div>
          ))
        )}
        {loading && <div style={{ color: '#666', fontSize: '14px' }}>Thinking…</div>}
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about meals, recipes, or what to add…"
          disabled={!token || loading}
          style={{
            flex: '1 1 200px',
            padding: '10px',
            fontSize: '15px',
            border: '1px solid #ccc',
            borderRadius: '4px',
          }}
        />
        <button
          type="submit"
          disabled={!token || loading || !input.trim()}
          style={{
            padding: '10px 18px',
            cursor: !token || loading || !input.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          Send
        </button>
      </form>
    </section>
  );
}
