import { useLocale, text } from '../i18n';
import { TodoItem } from './TodoItem';
import type { Todo } from '../types';

interface TodoListProps {
  todos: Todo[];
  onTodoUpdated: () => void;
  onTodoDeleted: () => void;
}

export function TodoList({ todos, onTodoUpdated, onTodoDeleted }: TodoListProps) {
  useLocale();
  if (todos.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>{text("No todos yet. Create one above!")}</div>
    );
  }

  return (
    <div>
      <h2>{text("Your Todos (")}{todos.length}{text(")")}</h2>
      {todos.map((todo) => (
        <TodoItem
          key={todo.id}
          todo={todo}
          onTodoUpdated={onTodoUpdated}
          onTodoDeleted={onTodoDeleted}
        />
      ))}
    </div>
  );
}
