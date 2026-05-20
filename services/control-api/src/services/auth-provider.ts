export interface UserClaims {
  sub: string;
  email: string;
  email_verified: boolean;
}

export interface AuthProvider {
  verifyJwt(token: string): Promise<UserClaims>;
}
