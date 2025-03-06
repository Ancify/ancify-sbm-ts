export class AuthContext {
    userId?: string;
    roles: string[];
    scope?: string;
    success: boolean;
    sessionData?: any;
    isConnectionAllowed: boolean;
  
    constructor(
      userId?: string,
      roles: string[] = [],
      scope?: string,
      sessionData?: any,
      success: boolean = false,
      isConnectionAllowed: boolean = false
    ) {
      this.userId = userId;
      this.roles = roles;
      this.scope = scope;
      this.sessionData = sessionData;
      this.success = success;
      this.isConnectionAllowed = isConnectionAllowed;
    }
  
    /**
     * Static instance representing a failed authentication attempt.
     */
    public static get Failed(): AuthContext {
      return new AuthContext(undefined, [], undefined, undefined, false, false);
    }
  
    /**
     * Creates a successful authentication context.
     */
    public static success(
      userId: string,
      roles: string[] = [],
      scope?: string,
      sessionData?: any
    ): AuthContext {
      return new AuthContext(userId, roles, scope, sessionData, true, true);
    }
  
    /**
     * Converts a raw object (e.g., JSON response) into an `AuthContext` instance.
     */
    public static fromObject(obj: any): AuthContext {
      return new AuthContext(
        obj.userId,
        obj.roles ?? [],
        obj.scope,
        obj.sessionData,
        obj.success ?? false,
        obj.isConnectionAllowed ?? false
      );
    }
  }
  