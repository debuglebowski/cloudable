export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}
export interface PaginatedRequest {
  cursor?: string;
  limit?: number; // default 25, max 100, server-enforced
}
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}
