import { TodoItem } from './TodoItem';
import type { Todo } from '../types';

interface TodoListProps {
  todos: Todo[];
  onTodoUpdated: () => void;
  onTodoDeleted: () => void;
}

export function TodoList({ todos, onTodoUpdated, onTodoDeleted }: TodoListProps) {
  if (todos.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
        No todos yet. Create one above!
      </div>
    );
  }

  return (
    <div>
      <h2>Your Todos ({todos.length})</h2>
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
