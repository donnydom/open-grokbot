/**
 * WebAuthn provider stub.
 *
 * The original coordinator carries a WebAuthn provider so the desktop shell
 * can broker hardware-key ceremonies (makeCredential / getAssertion) for
 * account login and device binding. Here it is a contract + in-memory
 * simulator: ceremony request/response shapes are stable, the authenticator
 * itself is pluggable (a real implementation would talk to the OS keychain /
 * FIDO2 stack).
 */

export interface MakeCredentialRequest {
  challenge: string;
  rpId: string;
  userId: string;
}

export interface MakeCredentialResult {
  credentialId: string;
  attestation: string;
}

export interface GetAssertionRequest {
  challenge: string;
  rpId: string;
  credentialId: string;
}

export interface GetAssertionResult {
  signature: string;
  authenticatorData: string;
}

export interface WebAuthnProvider {
  makeCredential(request: MakeCredentialRequest): Promise<MakeCredentialResult>;
  getAssertion(request: GetAssertionRequest): Promise<GetAssertionResult>;
}

/** Deterministic simulator for tests and offline demos. */
export function createSimulatedWebAuthnProvider(): WebAuthnProvider {
  const credentials = new Map<string, string>(); // userId -> credentialId
  return {
    async makeCredential(request) {
      const credentialId = `cred-${request.userId}-${request.challenge.slice(0, 8)}`;
      credentials.set(request.userId, credentialId);
      return { credentialId, attestation: "simulated" };
    },
    async getAssertion(request) {
      if (credentials.get(request.credentialId) == null && !request.credentialId.startsWith("cred-")) {
        throw Object.assign(new Error("credential not found"), { name: "WebAuthnNotFoundError" });
      }
      return {
        signature: `sig-${request.challenge.slice(0, 8)}`,
        authenticatorData: "simulated",
      };
    },
  };
}
