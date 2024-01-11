/*
 * @adonisjs/auth
 *
 * (c) AdonisJS
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { SessionMiddlewareFactory } from '@adonisjs/session/factories'

import { FactoryUser } from '../../../factories/core/lucid_user_provider.js'
import { SessionGuardFactory } from '../../../factories/session_guard_factory.js'
import { RememberMeToken } from '../../../src/guards/session/remember_me_token.js'
import { DatabaseRememberTokenProvider } from '../../../src/guards/session/token_providers/database.js'
import {
  pEvent,
  timeTravel,
  parseCookies,
  createTables,
  defineCookies,
  createDatabase,
  createEmitter,
} from '../../helpers.js'

test.group('Session guard | authenticate | session id', () => {
  test('authenticate existing session for auth', async ({ assert, expectTypeOf }) => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    const user = await FactoryUser.createWithDefaults()
    const sessionGuard = new SessionGuardFactory().create(ctx, emitter)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    const [authSucceeded] = await Promise.all([
      pEvent(emitter, 'session_auth:authentication_succeeded'),
      sessionMiddleware.handle(ctx, async () => {
        ctx.session.put('auth_web', user.id)
        await sessionGuard.authenticate()
        expectTypeOf(sessionGuard.authenticate).returns.toMatchTypeOf<Promise<FactoryUser>>()
      }),
    ])

    assert.equal(authSucceeded!.sessionId, ctx.session.sessionId)
    assert.equal(authSucceeded!.user.id, user.id)
    assert.isUndefined(authSucceeded!.rememberMeToken)
    assert.equal(sessionGuard.getUserOrFail().id, user.id)
    assert.isFalse(sessionGuard.isLoggedOut)
    assert.isTrue(sessionGuard.isAuthenticated)
    assert.isTrue(sessionGuard.authenticationAttempted)
    assert.isFalse(sessionGuard.viaRemember)
    assert.deepEqual(ctx.session.all(), { auth_web: user.id })
  })

  test('throw error when session does not have user id', async ({ assert }) => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    await FactoryUser.createWithDefaults()
    const sessionGuard = new SessionGuardFactory().create(ctx, emitter)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    const [authFailed, authenticateCall] = await Promise.allSettled([
      pEvent(emitter, 'session_auth:authentication_failed'),
      sessionMiddleware.handle(ctx, async () => {
        await sessionGuard.authenticate()
      }),
    ])

    assert.equal(authFailed.status, 'fulfilled')
    assert.equal(authenticateCall.status, 'rejected')
    assert.equal(
      ('reason' in authenticateCall && authenticateCall.reason).message,
      'Invalid or expired authentication session'
    )
  })

  test('throw error when session has id but user has been deleted', async () => {
    const db = await createDatabase()
    await createTables(db)

    const ctx = new HttpContextFactory().create()
    const emitter = createEmitter()
    const user = await FactoryUser.createWithDefaults()
    const sessionGuard = new SessionGuardFactory().create(ctx, emitter)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    await user.delete()

    await sessionMiddleware.handle(ctx, async () => {
      ctx.session.put('auth_web', user.id)
      await sessionGuard.authenticate()
    })
  }).throws('Invalid or expired authentication session')
})

test.group('Session guard | authenticate | remember me token', () => {
  test('create session when authentication is sucessful via remember me tokens', async ({
    assert,
  }) => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    const user = await FactoryUser.createWithDefaults()
    const tokensProvider = new DatabaseRememberTokenProvider(db, { table: 'remember_me_tokens' })
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    const sessionGuard = new SessionGuardFactory()
      .create(ctx, emitter)
      .withRememberMeTokens(tokensProvider)

    const token = RememberMeToken.create(user.id, '1 year', 'web')
    await tokensProvider.createToken(token)

    ctx.request.request.headers.cookie = defineCookies([
      {
        key: 'remember_web',
        value: token.value!.release(),
        type: 'encrypted',
      },
    ])

    const [authSucceeded] = await Promise.all([
      pEvent(emitter, 'session_auth:authentication_succeeded'),
      sessionMiddleware.handle(ctx, async () => {
        await sessionGuard.authenticate()
      }),
    ])

    assert.equal(authSucceeded!.sessionId, ctx.session.sessionId)
    assert.equal(authSucceeded!.user.id, user.id)
    assert.exists(authSucceeded!.rememberMeToken)
    assert.equal(sessionGuard.getUserOrFail().id, user.id)
    assert.isFalse(sessionGuard.isLoggedOut)
    assert.isTrue(sessionGuard.isAuthenticated)
    assert.isTrue(sessionGuard.authenticationAttempted)
    assert.isTrue(sessionGuard.viaRemember)
    assert.deepEqual(ctx.session.all(), { auth_web: user.id })

    /**
     * Since the token was generated within 1 minute of using
     * it. We do not refresh it inside the db
     */
    const freshToken = await tokensProvider.getTokenBySeries(token.series)
    assert.equal(freshToken!.hash, token.hash)

    const parsedCookies = parseCookies(ctx.response.getHeader('set-cookie') as string[])
    assert.equal(parsedCookies.remember_web.value, token.value!.release())
  })

  test('recycle remember me token when using it after 1 min of last update', async ({ assert }) => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    const user = await FactoryUser.createWithDefaults()
    const tokensProvider = new DatabaseRememberTokenProvider(db, { table: 'remember_me_tokens' })
    const sessionGuard = new SessionGuardFactory()
      .create(ctx, emitter)
      .withRememberMeTokens(tokensProvider)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    const token = RememberMeToken.create(user.id, '1 year', 'web')
    await tokensProvider.createToken(token)

    /**
     * Travel 1 minute in future
     */
    timeTravel(60)

    ctx.request.request.headers.cookie = defineCookies([
      {
        key: 'remember_web',
        value: token.value!.release(),
        type: 'encrypted',
      },
    ])

    await sessionMiddleware.handle(ctx, async () => {
      await sessionGuard.authenticate()
    })

    assert.equal(sessionGuard.getUserOrFail().id, user.id)
    assert.isFalse(sessionGuard.isLoggedOut)
    assert.isTrue(sessionGuard.isAuthenticated)
    assert.isTrue(sessionGuard.authenticationAttempted)
    assert.isTrue(sessionGuard.viaRemember)
    assert.deepEqual(ctx.session.all(), { auth_web: user.id })

    const cookies = parseCookies(ctx.response.getHeader('set-cookie') as string[])
    const decodedToken = RememberMeToken.decode(cookies.remember_web.value)!

    /**
     * Since the token was generated within 1 minute of using
     * it. We do not refresh it inside the db
     */
    const freshToken = await tokensProvider.getTokenBySeries(decodedToken.series)
    assert.notEqual(freshToken!.hash, token.hash)
    assert.equal(freshToken!.series, token.series)

    const parsedCookies = parseCookies(ctx.response.getHeader('set-cookie') as string[])
    assert.notEqual(parsedCookies.remember_web.value, token.value)
  })

  test('throw error when remember me token is invalid', async () => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    const tokensProvider = new DatabaseRememberTokenProvider(db, { table: 'remember_me_tokens' })
    const sessionGuard = new SessionGuardFactory()
      .create(ctx, emitter)
      .withRememberMeTokens(tokensProvider)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    ctx.request.request.headers.cookie = defineCookies([
      {
        key: 'remember_web',
        value: 'foobar',
        type: 'encrypted',
      },
    ])

    await sessionMiddleware.handle(ctx, async () => {
      await sessionGuard.authenticate()
    })
  }).throws('Invalid or expired authentication session')

  test('throw error when remember me token has been expired', async () => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    const user = await FactoryUser.createWithDefaults()
    const tokensProvider = new DatabaseRememberTokenProvider(db, { table: 'remember_me_tokens' })
    const sessionGuard = new SessionGuardFactory()
      .create(ctx, emitter)
      .withRememberMeTokens(tokensProvider)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    const token = RememberMeToken.create(user.id, '1 minute', 'web')
    await tokensProvider.createToken(token)

    /**
     * Travel 2 minute in future
     */
    timeTravel(120)

    ctx.request.request.headers.cookie = defineCookies([
      {
        key: 'remember_web',
        value: token.value!.release(),
        type: 'encrypted',
      },
    ])

    await sessionMiddleware.handle(ctx, async () => {
      await sessionGuard.authenticate()
    })
  }).throws('Invalid or expired authentication session')

  test('throw error when remember me token does not exist', async () => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    const user = await FactoryUser.createWithDefaults()
    const tokensProvider = new DatabaseRememberTokenProvider(db, { table: 'remember_me_tokens' })
    const sessionGuard = new SessionGuardFactory()
      .create(ctx, emitter)
      .withRememberMeTokens(tokensProvider)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    const token = RememberMeToken.create(user.id, '1 year', 'web')

    ctx.request.request.headers.cookie = defineCookies([
      {
        key: 'remember_web',
        value: token.value!.release(),
        type: 'encrypted',
      },
    ])

    await sessionMiddleware.handle(ctx, async () => {
      await sessionGuard.authenticate()
    })
  }).throws('Invalid or expired authentication session')

  test('throw error when user has been deleted', async () => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    const user = await FactoryUser.createWithDefaults()
    const tokensProvider = new DatabaseRememberTokenProvider(db, { table: 'remember_me_tokens' })
    const sessionGuard = new SessionGuardFactory()
      .create(ctx, emitter)
      .withRememberMeTokens(tokensProvider)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    const token = RememberMeToken.create(user.id, '1 year', 'web')
    await tokensProvider.createToken(token)

    await user.delete()

    ctx.request.request.headers.cookie = defineCookies([
      {
        key: 'remember_web',
        value: token.value!.release(),
        type: 'encrypted',
      },
    ])

    await sessionMiddleware.handle(ctx, async () => {
      await sessionGuard.authenticate()
    })
  }).throws('Invalid or expired authentication session')

  test('throw error when remember me token type does not match', async () => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    const user = await FactoryUser.createWithDefaults()
    const tokensProvider = new DatabaseRememberTokenProvider(db, { table: 'remember_me_tokens' })
    const sessionGuard = new SessionGuardFactory()
      .create(ctx, emitter)
      .withRememberMeTokens(tokensProvider)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    const token = RememberMeToken.create(user.id, '1 year', 'web')
    await tokensProvider.createToken(token)

    /**
     * A matching token generated for different purpose should
     * fail.
     */
    await db.from('remember_me_tokens').where('series', token.series).update({ type: 'foo_token' })

    ctx.request.request.headers.cookie = defineCookies([
      {
        key: 'remember_web',
        value: token.value!.release(),
        type: 'encrypted',
      },
    ])

    await sessionMiddleware.handle(ctx, async () => {
      await sessionGuard.authenticate()
    })
  }).throws('Invalid or expired authentication session')

  test('multiple calls to authenticate should result in noop', async ({ assert }) => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    const user = await FactoryUser.createWithDefaults()
    const sessionGuard = new SessionGuardFactory().create(ctx, emitter)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    await sessionMiddleware.handle(ctx, async () => {
      ctx.session.put('auth_web', user.id)
      await sessionGuard.authenticate()
      await user.delete()
      const authUser = await sessionGuard.authenticate()
      assert.equal(authUser.id, user.id)
    })
  })
})

test.group('Session guard | check', () => {
  test('return logged-in user when check method called', async ({ assert }) => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    const user = await FactoryUser.createWithDefaults()
    const sessionGuard = new SessionGuardFactory().create(ctx, emitter)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    const [authFailed, authenticateCall] = await Promise.allSettled([
      pEvent(emitter, 'session_auth:authentication_failed'),
      sessionMiddleware.handle(ctx, async () => {
        ctx.session.put('auth_web', user.id)
        return sessionGuard.check()
      }),
    ])

    assert.equal(authFailed.status, 'fulfilled')
    assert.equal(authenticateCall.status, 'fulfilled')
    if (authenticateCall.status === 'fulfilled') {
      assert.isTrue(authenticateCall.value)
    }
  })

  test('do not throw error when auth.check is used with non-logged in user', async ({ assert }) => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    await FactoryUser.createWithDefaults()
    const sessionGuard = new SessionGuardFactory().create(ctx, emitter)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    const [authFailed, authenticateCall] = await Promise.allSettled([
      pEvent(emitter, 'session_auth:authentication_failed'),
      sessionMiddleware.handle(ctx, async () => {
        return sessionGuard.check()
      }),
    ])

    assert.equal(authFailed.status, 'fulfilled')
    assert.equal(authenticateCall.status, 'fulfilled')
    if (authenticateCall.status === 'fulfilled') {
      assert.isFalse(authenticateCall.value)
    }
  })

  test('throw error when calling authenticate after check', async ({ assert }) => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    await FactoryUser.createWithDefaults()
    const sessionGuard = new SessionGuardFactory().create(ctx, emitter)
    const sessionMiddleware = await new SessionMiddlewareFactory().create()

    const [authFailed, authenticateCall] = await Promise.allSettled([
      pEvent(emitter, 'session_auth:authentication_failed'),
      sessionMiddleware.handle(ctx, async () => {
        await sessionGuard.check()
        await sessionGuard.authenticate()
      }),
    ])

    assert.equal(authFailed.status, 'fulfilled')
    assert.equal(authenticateCall.status, 'rejected')
    assert.equal(
      ('reason' in authenticateCall && authenticateCall.reason).message,
      'Invalid or expired authentication session'
    )
  })
})

test.group('Session guard | authenticateAsClient', () => {
  test('get authentication session via authenticateAsClient', async ({ assert }) => {
    const db = await createDatabase()
    await createTables(db)

    const emitter = createEmitter()
    const ctx = new HttpContextFactory().create()
    const user = await FactoryUser.createWithDefaults()
    const sessionGuard = new SessionGuardFactory().create(ctx, emitter)

    assert.deepEqual(await sessionGuard.authenticateAsClient(user), {
      session: {
        auth_web: user.id,
      },
    })
  })
})
