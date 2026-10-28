export type Action = 'label' | 'star' | 'mark_read' | 'archive';

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string; // raw From header
  address: string; // lowercased bare address
  domain: string; // lowercased domain of address
  subject: string;
  date: string;
  hasListUnsubscribe: boolean;
  body: string; // plain text, already cleaned and truncated
  labelIds: string[];
}

export type DecisionSource = 'rule' | 'cache' | 'model' | 'fallback';

export interface Decision {
  category: string;
  confidence: number;
  source: DecisionSource;
  reason: string;
}

export interface ModifyRequest {
  add: string[];
  remove: string[];
}

/** Everything the pipeline needs from Gmail. Tests supply a fake. */
export interface MailClient {
  /** Returns name -> label id for existing labels; creates the missing ones only if `create`. */
  ensureLabels(names: string[], create: boolean): Promise<Map<string, string>>;
  /** New message ids since the cursor; with no cursor, the last `backlogDays` days. */
  listNew(cursor: string | null, backlogDays: number): Promise<{ ids: string[]; cursor: string }>;
  fetchMessage(id: string, maxBodyChars: number): Promise<EmailMessage>;
  modify(id: string, change: ModifyRequest): Promise<void>;
}
