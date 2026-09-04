import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { WidgetMessage } from '../lib';

export function MessageThread({ messages, aiTyping }: { messages: WidgetMessage[]; aiTyping?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages.length, aiTyping]);

  return (
    <div
      ref={ref}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
      style={{ background: 'linear-gradient(180deg, #FAF6EC 0%, #F4ECDB 100%)' }}
    >
      {messages.length === 0 && (
        <div className="flex flex-col items-center text-center py-10 px-2">
          <div
            className="grid h-12 w-12 place-items-center rounded-2xl mb-3"
            style={{
              background: 'linear-gradient(135deg, #FBE08E, #F5C842)',
              boxShadow: '0 8px 20px -8px rgba(245, 200, 66, 0.55)',
            }}
          >
            <span className="text-lg">▲</span>
          </div>
          <div className="bs-display text-[17px] tracking-tight text-[#2A1C0A]">
            How can we help?
          </div>
          <div className="mt-1 text-[12px] text-[#7A6F5C] leading-relaxed max-w-[260px]">
            Send a message and we'll get back to you — fast and freshly baked.
          </div>
        </div>
      )}
      {messages.map((m) => {
        const isCustomer = m.role === 'customer';
        return (
          <div
            key={m.message_id}
            className={isCustomer ? 'ml-auto max-w-[85%]' : 'mr-auto max-w-[88%]'}
          >
            {!isCustomer && m.sender_name && (
              <div className="mb-1 ml-1 text-[10px] font-mono uppercase tracking-[0.14em] text-[#9C8E7A]">
                {m.sender_name}
              </div>
            )}
            <div
              className={
                isCustomer
                  ? 'rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13.5px] leading-relaxed text-[#2A1C0A]'
                  : 'rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 text-[13.5px] leading-relaxed text-[#2A1C0A] border border-[#2A1C0A]/[0.06]'
              }
              style={
                isCustomer
                  ? {
                      background: 'linear-gradient(135deg, #FBE08E 0%, #F5C842 100%)',
                      boxShadow: '0 4px 12px -4px rgba(245, 200, 66, 0.4)',
                    }
                  : undefined
              }
            >
              {isCustomer ? (
                <div className="whitespace-pre-wrap">{m.body}</div>
              ) : (
                <div className="bs-md whitespace-pre-wrap break-words">
                  <ReactMarkdown
                    components={{
                      p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-[#7A5A0F] hover:text-[#5A4209]">
                          {children}
                        </a>
                      ),
                      ul: ({ children }) => <ul className="mb-2 last:mb-0 list-disc pl-5 space-y-0.5">{children}</ul>,
                      ol: ({ children }) => <ol className="mb-2 last:mb-0 list-decimal pl-5 space-y-0.5">{children}</ol>,
                      li: ({ children }) => <li className="leading-snug">{children}</li>,
                      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                      em: ({ children }) => <em className="italic">{children}</em>,
                      code: ({ children }) => (
                        <code className="rounded bg-[#F4ECDB] px-1 py-0.5 text-[12px] font-mono text-[#2A1C0A]">
                          {children}
                        </code>
                      ),
                      pre: ({ children }) => (
                        <pre className="mb-2 last:mb-0 overflow-x-auto rounded-md bg-[#F4ECDB] p-2 text-[12px] font-mono text-[#2A1C0A]">
                          {children}
                        </pre>
                      ),
                      h1: ({ children }) => <div className="mb-1 font-semibold text-[14px]">{children}</div>,
                      h2: ({ children }) => <div className="mb-1 font-semibold text-[14px]">{children}</div>,
                      h3: ({ children }) => <div className="mb-1 font-semibold text-[13.5px]">{children}</div>,
                      hr: () => <hr className="my-2 border-[#2A1C0A]/10" />,
                      blockquote: ({ children }) => (
                        <blockquote className="mb-2 last:mb-0 border-l-2 border-[#F5C842] pl-2 text-[#574A35]">
                          {children}
                        </blockquote>
                      ),
                    }}
                  >
                    {m.body || ''}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {aiTyping && <TypingIndicator />}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="mr-auto max-w-[88%]">
      <div
        className="inline-flex items-center gap-1 rounded-2xl rounded-bl-md bg-white px-3.5 py-3 border border-[#2A1C0A]/[0.06]"
        aria-label="Assistant is typing"
      >
        <Dot delay="0ms" />
        <Dot delay="160ms" />
        <Dot delay="320ms" />
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-[#C9A53A]"
      style={{
        animation: 'bs-typing-bounce 1.1s ease-in-out infinite',
        animationDelay: delay,
      }}
    />
  );
}
