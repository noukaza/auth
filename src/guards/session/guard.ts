/*
 * @adonisjs/auth
 *
 * (c) AdonisJS
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/// <reference types="@adonisjs/session/session_middleware" />

import type { HttpContext } from '@adonisjs/core/http'
import { Exception, RuntimeException } from '@poppinss/utils'
import type { EmitterLike } from '@adonisjs/core/types/events'

import debug from '../../auth/debug.js'
import { RememberMeToken } from './remember_me_token.js'
import type { GuardContract } from '../../auth/types.js'
import { GUARD_KNOWN_EVENTS, PROVIDER_REAL_USER } from '../../auth/symbols.js'
import { AuthenticationException, InvalidCredentialsException } from '../../auth/errors.js'
import type {
  SessionGuardEvents,
  SessionGuardConfig,
  RememberMeProviderContract,
  SessionUserProviderContract,
} from './types.js'

/**
 * Session guard uses sessions and cookies to login and authenticate
 * users.
 */
export class SessionGuard<UserProvider extends SessionUserProviderContract<unknown>>
  implements GuardContract<UserProvider[typeof PROVIDER_REAL_USER]>
{
  declare [GUARD_KNOWN_EVENTS]: SessionGuardEvents<UserProvider[typeof PROVIDER_REAL_USER]>

  /**
   * A unique name for the guard. It is used for prefixing
   * session data and remember me cookies
   */
  #name: string

  /**
   * Reference to the current HTTP context
   */
  #ctx: HttpContext

  /**
   * Configuration
   */
  #config: SessionGuardConfig

  /**
   * Provider to lookup user details
   */
  #userProvider: UserProvider

  /**
   * The remember me tokens provider to use to persist
   * remember me tokens
   */
  #rememberMeTokenProvider?: RememberMeProviderContract

  /**
   * Emitter to emit events
   */
  #emitter: EmitterLike<SessionGuardEvents<UserProvider[typeof PROVIDER_REAL_USER]>>

  /**
   * Driver name of the guard
   */
  driverName: 'session' = 'session'

  /**
   * Whether or not the authentication has been attempted
   * during the current request
   */
  authenticationAttempted = false

  /**
   * Find if the user has been logged out during
   * the current request
   */
  isLoggedOut = false

  /**
   * A boolean to know if the current request has
   * been authenticated
   */
  isAuthenticated = false

  /**
   * A boolean to know if the current request is authenticated
   * using the "rememember_me" token.
   */
  viaRemember = false

  /**
   * Reference to an instance of the authenticated or logged-in
   * user. The value only exists after calling one of the
   * following methods.
   *
   * - login
   * - loginViaId
   * - attempt
   * - authenticate
   *
   * You can use the "getUserOrFail" method to throw an exception if
   * the request is not authenticated.
   */
  user?: UserProvider[typeof PROVIDER_REAL_USER]

  /**
   * The key used to store the logged-in user id inside
   * session
   */
  get sessionKeyName() {
    return `auth_${this.#name}`
  }

  /**
   * The key used to store the remember me token cookie
   */
  get rememberMeKeyName() {
    return `remember_${this.#name}`
  }

  constructor(
    name: string,
    config: SessionGuardConfig,
    ctx: HttpContext,
    emitter: EmitterLike<SessionGuardEvents<UserProvider[typeof PROVIDER_REAL_USER]>>,
    userProvider: UserProvider
  ) {
    this.#name = name
    this.#ctx = ctx
    this.#config = config
    this.#emitter = emitter
    this.#userProvider = userProvider
  }

  /**
   * Returns an instance of the tokens provider, ensuring
   * it has been configured
   */
  #getTokenProvider() {
    if (!this.#rememberMeTokenProvider) {
      throw new RuntimeException(
        'Cannot use "rememberMe" feature. Please configure the tokens provider inside config/auth file'
      )
    }

    return this.#rememberMeTokenProvider
  }

  /**
   * Returns the session instance for the given request,
   * ensuring the property exists
   */
  #getSession() {
    if (!('session' in this.#ctx)) {
      throw new RuntimeException(
        'Cannot login user. Make sure you have installed the "@adonisjs/session" package and configured its middleware'
      )
    }

    return this.#ctx.session
  }

  /**
   * Notifies about authentication failure and throws the exception
   */
  #authenticationFailed(error: Exception, sessionId: string): never {
    this.#emitter.emit('session_auth:authentication_failed', {
      ctx: this.#ctx,
      guardName: this.#name,
      error,
      sessionId: sessionId,
    })

    throw error
  }

  /**
   * Notifies about login failure and throws the exception
   */
  #loginFailed(error: Exception): never {
    this.#emitter.emit('session_auth:login_failed', {
      ctx: this.#ctx,
      guardName: this.#name,
      error,
    })

    throw error
  }

  /**
   * Register the remember me tokens provider to create
   * remember me tokens during user login.
   *
   * Note: This method only registers the remember me tokens provider
   * and does not enable them. You must pass "rememberMe = true" during
   * the "login" method call.
   */
  withRememberMeTokens(tokensProvider: RememberMeProviderContract): this {
    this.#rememberMeTokenProvider = tokensProvider
    return this
  }

  /**
   * Returns an instance of the authenticated user. Or throws
   * an exception if the request is not authenticated.
   */
  getUserOrFail(): UserProvider[typeof PROVIDER_REAL_USER] {
    if (!this.user) {
      throw AuthenticationException.E_INVALID_AUTH_SESSION()
    }

    return this.user
  }

  /**
   * Verifies user credentials and returns an instance of
   * the user or throws "E_INVALID_CREDENTIALS" exception.
   */
  async verifyCredentials(
    uid: string,
    password: string
  ): Promise<UserProvider[typeof PROVIDER_REAL_USER]> {
    debug('session_guard: attempting to verify credentials for uid "%s"', uid)

    /**
     * Attempt to verify credentials and raise error if they
     * are invalid
     */
    const providerUser = await this.#userProvider.verifyCredentials(uid, password)
    if (!providerUser) {
      this.#loginFailed(InvalidCredentialsException.E_INVALID_CREDENTIALS(this.driverName))
    }

    const user = providerUser.getOriginal()

    /**
     * Notify credentials have been verified
     */
    this.#emitter.emit('session_auth:credentials_verified', {
      ctx: this.#ctx,
      guardName: this.#name,
      uid,
      user,
    })

    return user
  }

  /**
   * Attempt to login a user after verifying their
   * credentials.
   */
  async attempt(
    uid: string,
    password: string,
    remember?: boolean
  ): Promise<UserProvider[typeof PROVIDER_REAL_USER]> {
    const user = await this.verifyCredentials(uid, password)
    return this.login(user, remember)
  }

  /**
   * Attempt to login a user using the user id. The
   * user will be first fetched from the db before
   * marking them as logged-in
   */
  async loginViaId(
    id: string | number,
    remember?: boolean
  ): Promise<UserProvider[typeof PROVIDER_REAL_USER]> {
    debug('session_guard: attempting to login user via id "%s"', id)

    const providerUser = await this.#userProvider.findById(id)
    if (!providerUser) {
      this.#loginFailed(InvalidCredentialsException.E_INVALID_CREDENTIALS(this.driverName))
    }

    return this.login(providerUser.getOriginal(), remember)
  }

  /**
   * Login a user using the user object.
   */
  async login(
    user: UserProvider[typeof PROVIDER_REAL_USER],
    remember: boolean = false
  ): Promise<UserProvider[typeof PROVIDER_REAL_USER]> {
    this.#emitter.emit('session_auth:login_attempted', {
      ctx: this.#ctx,
      user,
      guardName: this.#name,
    })

    const providerUser = await this.#userProvider.createUserForGuard(user)
    const session = this.#getSession()
    const userId = providerUser.getId()

    /**
     * Create session and recycle the session id
     */
    debug('session_guard: marking user with id "%s" as logged-in', userId)
    session.put(this.sessionKeyName, userId)
    session.regenerate()

    /**
     * Manage remember me cookie
     */
    let token: RememberMeToken | undefined
    if (remember) {
      const tokenProvider = this.#getTokenProvider()
      const rememberMeTokenAge = this.#config.rememberMeTokenAge || '2years'

      /**
       * Create a token
       */
      token = RememberMeToken.create(providerUser.getId(), rememberMeTokenAge, this.#name)

      /**
       * Persist remember me token inside the database
       */
      await tokenProvider.createToken(token)

      /**
       * Drop token value inside the cookie
       */
      debug('session_guard: creating remember me cookie')
      this.#ctx.response.encryptedCookie(this.rememberMeKeyName, token.value!.release(), {
        maxAge: rememberMeTokenAge,
        httpOnly: true,
      })
    } else {
      this.#ctx.response.clearCookie(this.rememberMeKeyName)
    }

    /**
     * Toggle properties to mark user as logged-in
     */
    this.user = user
    this.isLoggedOut = false

    /**
     * Notify the login is successful
     */
    this.#emitter.emit('session_auth:login_succeeded', {
      ctx: this.#ctx,
      guardName: this.#name,
      user,
      sessionId: session.sessionId,
      rememberMeToken: token,
    })

    return user
  }

  /**
   * Authenticates the HTTP request to ensure the
   * user is logged-in
   */
  async authenticate(): Promise<UserProvider[typeof PROVIDER_REAL_USER]> {
    if (this.authenticationAttempted) {
      return this.getUserOrFail()
    }

    this.authenticationAttempted = true
    const session = this.#getSession()

    /**
     * Notify we are starting authentication process
     */
    this.#emitter.emit('session_auth:authentication_attempted', {
      ctx: this.#ctx,
      guardName: this.#name,
      sessionId: session.sessionId,
    })

    /**
     * Check if there is a user id inside the session store.
     * If yes, fetch the user from the persistent storage
     * and mark them as logged-in
     */
    const loggedInUserId = session.get(this.sessionKeyName)
    if (loggedInUserId) {
      debug('session_guard: authenticating user from session')
      const providerUser = await this.#userProvider.findById(loggedInUserId)

      /**
       * Throw error when user is not found inside the persistent
       * storage
       */
      if (!providerUser) {
        this.#authenticationFailed(
          AuthenticationException.E_INVALID_AUTH_SESSION(),
          session.sessionId
        )
      }

      debug('session_guard: marking user with id "%s" as authenticated', providerUser.getId())
      this.user = providerUser.getOriginal()
      this.isAuthenticated = true
      this.isLoggedOut = false
      this.viaRemember = false

      /**
       * Authentication was successful
       */
      this.#emitter.emit('session_auth:authentication_succeeded', {
        ctx: this.#ctx,
        guardName: this.#name,
        sessionId: session.sessionId,
        user: this.user,
      })

      return this.user
    }

    /**
     * Otherwise check for remember me cookie and attempt
     * to login user via that.
     *
     * Also, if the remember me token provider is not registered,
     * we will silently ignore the remember me cookie and
     * throw invalid session exception
     *
     * This is because, sometimes an app might use the remember me
     * tokens initially and then back out and stop using them. In
     * that case, we should not fail authentication attempts, just
     * ignore the remember me cookie.
     */
    const rememberMeCookie = this.#ctx.request.encryptedCookie(this.rememberMeKeyName)
    if (!rememberMeCookie || !this.#rememberMeTokenProvider) {
      this.#authenticationFailed(
        AuthenticationException.E_INVALID_AUTH_SESSION(),
        session.sessionId
      )
    }

    debug('session_guard: authenticating user from remember me cookie')

    /**
     * Decode remember me cookie and check for its existence inside
     * the database. Throw invalid session exception when token
     * is missing or invalid
     */
    const decodedToken = RememberMeToken.decode(rememberMeCookie)
    if (!decodedToken) {
      this.#authenticationFailed(
        AuthenticationException.E_INVALID_AUTH_SESSION(),
        session.sessionId
      )
    }

    /**
     * Fail if token is missing, hash mis-matches, or the token guard does not
     * match the current guards name
     */
    const token = await this.#rememberMeTokenProvider.getTokenBySeries(decodedToken.series)
    if (!token || !token.verify(decodedToken.value) || token.guard !== this.#name) {
      this.#authenticationFailed(
        AuthenticationException.E_INVALID_AUTH_SESSION(),
        session.sessionId
      )
    }

    debug('session_guard: found valid remember me token')

    /**
     * Find user for whom the token was created. Throw invalid
     * session exception when the user is missing
     */
    const providerUser = await this.#userProvider.findById(token.userId)
    if (!providerUser) {
      this.#authenticationFailed(
        AuthenticationException.E_INVALID_AUTH_SESSION(),
        session.sessionId
      )
    }

    /**
     * Finally, login the user from the remember me token
     */
    const userId = providerUser.getId()
    debug('session_guard: marking user with id "%s" as logged in from remember me cookie', userId)
    session.put(this.sessionKeyName, userId)
    session.regenerate()

    debug('session_guard: marking user with id "%s" as authenticated', userId)
    this.user = providerUser.getOriginal()
    this.isAuthenticated = true
    this.isLoggedOut = false
    this.viaRemember = true

    /**
     * Authentication was successful via remember me token
     */
    this.#emitter.emit('session_auth:authentication_succeeded', {
      ctx: this.#ctx,
      guardName: this.#name,
      sessionId: session.sessionId,
      user: this.user!,
      rememberMeToken: token,
    })

    /**
     * ----------------------------------------------------------------
     * User is logged in now. From here on we are refreshing the
     * remember me token.
     * ----------------------------------------------------------------
     *
     * Here we refresh the token value inside the db when the
     * current remember_me token is older than 1 minute.
     *
     * Otherwise, we re-use the same token. This is to avoid race-conditions
     * when parallel requests uses the remember_me token to authenticate
     * the user.
     *
     * Finally, we will update remember_me cookie lifespan in both the cases.
     * Be it updated the token inside databse, or not.
     */
    const currentTime = new Date()
    const rememberMeTokenAge = this.#config.rememberMeTokenAge || '2years'
    const updatedAtWithBuffer = new Date(token.updatedAt)
    updatedAtWithBuffer.setSeconds(updatedAtWithBuffer.getSeconds() + 60)

    if (updatedAtWithBuffer < currentTime) {
      /**
       * Refresh and update the token
       */
      token.refresh(rememberMeTokenAge)
      await this.#rememberMeTokenProvider.updateTokenBySeries(token.series, token)

      this.#ctx.response.encryptedCookie(this.rememberMeKeyName, token.value!.release(), {
        maxAge: rememberMeTokenAge,
        httpOnly: true,
      })
    } else {
      this.#ctx.response.encryptedCookie(this.rememberMeKeyName, rememberMeCookie, {
        maxAge: rememberMeTokenAge,
        httpOnly: true,
      })
    }

    return this.user!
  }

  /**
   * Silently attempt to authenticate the user.
   *
   * The method returns a boolean indicating if the authentication
   * succeeded or failed.
   */
  async check(): Promise<boolean> {
    try {
      await this.authenticate()
      return true
    } catch (error) {
      if (error instanceof AuthenticationException) {
        return false
      }

      throw error
    }
  }

  /**
   * Logout user and revoke remember me token (if any)
   */
  async logout() {
    debug('session_auth: logging out')
    const session = this.#getSession()

    /**
     * Clear client side state
     */
    session.forget(this.sessionKeyName)
    this.#ctx.response.clearCookie(this.rememberMeKeyName)

    /**
     * Notify the user has been logged out
     */
    this.#emitter.emit('session_auth:logged_out', {
      ctx: this.#ctx,
      guardName: this.#name,
      user: this.user || null,
      sessionId: session.sessionId,
    })

    const rememberMeCookie = this.#ctx.request.encryptedCookie(this.rememberMeKeyName)
    if (!rememberMeCookie || !this.#rememberMeTokenProvider) {
      return
    }

    debug('session_auth: decoding remember me token')
    const decodedToken = RememberMeToken.decode(rememberMeCookie)
    if (!decodedToken) {
      return
    }

    debug('session_auth: deleting remember me token')
    await this.#rememberMeTokenProvider.deleteTokenBySeries(decodedToken.series)
  }

  /**
   * Returns the session state for the user to be
   * logged-in as a client
   */
  async authenticateAsClient(
    user: UserProvider[typeof PROVIDER_REAL_USER]
  ): Promise<{ session: Record<string, string | number> }> {
    const providerUser = await this.#userProvider.createUserForGuard(user)
    const userId = providerUser.getId()

    debug('session_guard: returning client session for user id "%s"', userId)
    return {
      session: {
        [this.sessionKeyName]: userId,
      },
    }
  }
}
