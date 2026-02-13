import { Logger } from './logger';
import { Locale, t } from './messages';

export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

export class TodoManager {
  private logger = new Logger('TodoManager');
  private todos: Map<string, Todo[]> = new Map(); // sessionId -> todos

  updateTodos(sessionId: string, todos: Todo[]): void {
    this.todos.set(sessionId, todos);
    this.logger.debug('Updated todos for session', { 
      sessionId, 
      todoCount: todos.length,
      pending: todos.filter(t => t.status === 'pending').length,
      inProgress: todos.filter(t => t.status === 'in_progress').length,
      completed: todos.filter(t => t.status === 'completed').length,
    });
  }

  getTodos(sessionId: string): Todo[] {
    return this.todos.get(sessionId) || [];
  }

  formatTodoList(todos: Todo[], locale: Locale = 'en'): string {
    if (todos.length === 0) {
      return `📋 ${t('todo.title', locale)}\n\n${t('todo.empty', locale)}`;
    }

    let message = `📋 ${t('todo.title', locale)}\n\n`;

    // Group by status
    const pending = todos.filter(td => td.status === 'pending');
    const inProgress = todos.filter(td => td.status === 'in_progress');
    const completed = todos.filter(td => td.status === 'completed');

    // Show in-progress tasks first
    if (inProgress.length > 0) {
      message += `${t('todo.inProgress', locale)}\n`;
      for (const todo of inProgress) {
        const priority = this.getPriorityIcon(todo.priority);
        message += `${priority} ${todo.content}\n`;
      }
      message += '\n';
    }

    // Then pending tasks
    if (pending.length > 0) {
      message += `${t('todo.pending', locale)}\n`;
      for (const todo of pending) {
        const priority = this.getPriorityIcon(todo.priority);
        message += `${priority} ${todo.content}\n`;
      }
      message += '\n';
    }

    // Finally completed tasks
    if (completed.length > 0) {
      message += `${t('todo.completed', locale)}\n`;
      for (const todo of completed) {
        const priority = this.getPriorityIcon(todo.priority);
        message += `${priority} ~${todo.content}~\n`;
      }
    }

    // Add progress summary
    const total = todos.length;
    const completedCount = completed.length;
    const progress = total > 0 ? Math.round((completedCount / total) * 100) : 0;

    message += `\n${t('todo.progress', locale, { completed: completedCount, total, percent: progress })}`;

    return message;
  }

  private getPriorityIcon(priority: string): string {
    switch (priority) {
      case 'high':
        return '🔴';
      case 'medium':
        return '🟡';
      case 'low':
        return '🟢';
      default:
        return '⚪';
    }
  }

  hasSignificantChange(oldTodos: Todo[], newTodos: Todo[]): boolean {
    // Check if task count changed
    if (oldTodos.length !== newTodos.length) {
      return true;
    }

    // Check if any task status changed
    for (const newTodo of newTodos) {
      const oldTodo = oldTodos.find(t => t.id === newTodo.id);
      if (!oldTodo || oldTodo.status !== newTodo.status) {
        return true;
      }
    }

    return false;
  }

  getStatusChange(oldTodos: Todo[], newTodos: Todo[], locale: Locale = 'en'): string | null {
    // Find status changes
    const changes: string[] = [];

    for (const newTodo of newTodos) {
      const oldTodo = oldTodos.find(td => td.id === newTodo.id);

      if (!oldTodo) {
        // New task added
        changes.push(t('todo.added', locale, { content: newTodo.content }));
      } else if (oldTodo.status !== newTodo.status) {
        // Status changed
        const statusEmoji = {
          'pending': '⏳',
          'in_progress': '🔄',
          'completed': '✅'
        };

        changes.push(`${statusEmoji[newTodo.status]} ${newTodo.content}`);
      }
    }

    // Check for removed tasks
    for (const oldTodo of oldTodos) {
      if (!newTodos.find(td => td.id === oldTodo.id)) {
        changes.push(t('todo.removed', locale, { content: oldTodo.content }));
      }
    }

    return changes.length > 0 ? changes.join('\n') : null;
  }

  cleanupSession(sessionId: string): void {
    this.todos.delete(sessionId);
    this.logger.debug('Cleaned up todos for session', { sessionId });
  }
}