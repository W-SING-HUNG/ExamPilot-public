/* ExamPilot public portal: apply / status / invite / account (restore). No framework. */
;(function () {
  'use strict'
  var $ = function (id) {
    return document.getElementById(id)
  }
  var path = location.pathname.replace(/\/+$/, '') || '/apply'
  var mode = path === '/status' ? 'status' : path === '/invite' ? 'invite' : path === '/account' ? 'account' : 'apply'
  var params = new URLSearchParams(location.search)
  var ref = params.get('ref') || ''
  var inviteToken = mode === 'invite' ? location.hash.replace(/^#/, '') : ''
  if (inviteToken) history.replaceState(null, '', '/invite') // keep the token out of history / screenshots
  var cfg = null
  var tsWidget = null
  var tsToken = ''
  var me = null

  document.querySelectorAll('[data-nav]').forEach(function (a) {
    if (a.getAttribute('data-nav') === mode) a.setAttribute('aria-current', 'page')
  })

  function msg(text, kind) {
    var m = $('msg')
    m.textContent = text || ''
    m.className = 'msg' + (text ? ' show ' + (kind || 'info') : '')
  }
  function fmt(ms) {
    if (!ms) return ''
    return new Date(ms).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }
  function api(method, url, body) {
    var o = { method: method, credentials: 'same-origin', headers: {} }
    if (body !== undefined) {
      o.headers['Content-Type'] = 'application/json'
      o.headers['X-ExamPilot-Public'] = '1'
      o.body = JSON.stringify(body)
    }
    return fetch(url, o).then(
      function (r) {
        return r
          .json()
          .catch(function () {
            return { ok: false, reason: '服务暂时不可用' }
          })
          .then(function (j) {
            j._status = r.status
            return j
          })
      },
      function () {
        return { ok: false, reason: '网络连接失败，请检查网络后重试', _status: 0 }
      },
    )
  }
  function steps(i) {
    var lis = $('steps').children
    for (var k = 0; k < lis.length; k++) lis[k].className = k <= i ? 'on' : ''
  }
  function setTexts() {
    var t = cfg.texts
    var titles = { apply: t.title, status: '查询申请状态', invite: '接受邀请', account: '撤销账号注销' }
    var leads = {
      apply: cfg.open ? t.intro : t.paused,
      status: '验证邮箱后即可查看你的申请状态和申请日期。',
      invite: '你收到了 ExamPilot 的邀请。验证收到邀请的邮箱即可开通账号。',
      account: '注销后的 7 天冷静期内，验证邮箱即可撤销注销，账号和学习数据会原样恢复。',
    }
    $('title').textContent = titles[mode]
    $('lead').textContent = leads[mode]
    document.title = 'ExamPilot · ' + titles[mode]
    if (t.announcement) {
      $('ann').textContent = t.announcement
      $('ann').classList.remove('hidden')
    }
    if (mode !== 'apply') $('steps').classList.add('hidden')
    if (mode === 'invite' && !inviteToken) msg('邀请链接不完整。请直接点击邀请邮件里的链接。', 'err')
  }
  function renderTurnstile() {
    if (!cfg.turnstileSiteKey) return
    var s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__epTs'
    s.async = true
    window.__epTs = function () {
      tsWidget = window.turnstile.render('#ts', {
        sitekey: cfg.turnstileSiteKey,
        language: 'zh-cn',
        // the normal widget is 300 px wide: on very narrow phones (320 px) use the compact one so nothing overflows
        size: (document.getElementById('ts') || document.body).clientWidth < 300 ? 'compact' : 'normal',
        callback: function (tok) {
          tsToken = tok
        },
        'expired-callback': function () {
          tsToken = ''
        },
        'refresh-expired': 'auto',
        // show Cloudflare's error code (e.g. 600010 = this browser/network was judged risky) so a failure can be diagnosed
        'error-callback': function (code) {
          tsToken = ''
          msg(
            '人机验证未通过' +
              (code ? '（错误码 ' + code + '）' : '') +
              '。请刷新页面重试；如仍失败，请换用手机流量或其他浏览器，并关闭 VPN／广告拦截插件。',
            'err',
          )
          return true
        },
      })
    }
    document.head.appendChild(s)
  }

  function showVerified() {
    $('f-verify').classList.add('hidden')
    $('who').textContent = me.email
    if (mode === 'apply') {
      steps(1)
      if (me.canApply) {
        $('f-apply').classList.remove('hidden')
        if (ref) $('consentRow').classList.remove('hidden')
        $('note').focus()
      } else renderStatus()
    } else if (mode === 'invite') acceptInvite()
    else renderStatus()
  }

  var LABEL = { pending: '待审核', approved: '已通过', rejected: '未通过' }
  function renderStatus() {
    var box = $('s-status')
    box.classList.remove('hidden')
    box.textContent = ''
    var head = document.createElement('p')
    head.className = 'muted'
    head.textContent = '已验证：' + me.email
    box.appendChild(head)
    var m = me.member
    if (m) {
      var d = document.createElement('div')
      d.className = 'status'
      if (m.status === 'active' && m.canLogin) {
        d.innerHTML = '<span class="badge b-approved">账号已开通</span><p>用这个邮箱接收验证码即可登录学习站。</p>'
        if (cfg.appUrl) {
          var a = document.createElement('a')
          a.href = cfg.appUrl
          a.textContent = '前往学习站登录'
          d.appendChild(a)
        }
      } else if (m.status === 'active') {
        d.innerHTML =
          '<span class="badge b-pending">正在开通登录权限</span><p>账号已批准，登录权限正在开通，通常几分钟内完成。完成后会收到邮件。</p>'
      } else if (m.status === 'closing') {
        d.innerHTML =
          '<span class="badge b-rejected">注销冷静期</span><p>账号已停用，将在 ' +
          fmt(m.deleteAfter) +
          ' 之后删除学习数据。</p>'
        if (m.canRestore) {
          var b = document.createElement('button')
          b.className = 'pri'
          b.type = 'button'
          b.textContent = '撤销注销，恢复账号'
          b.onclick = restore
          d.appendChild(b)
        }
      } else {
        d.innerHTML = '<span class="badge b-rejected">访问已停用</span><p>如有疑问请联系管理员。</p>'
      }
      box.appendChild(d)
    }
    if (mode === 'account' && (!m || m.status !== 'closing')) {
      var n = document.createElement('p')
      n.textContent = '这个邮箱没有处于注销冷静期的账号。'
      box.appendChild(n)
    }
    if (mode !== 'account') {
      if (!me.applications.length && !m) {
        var e = document.createElement('p')
        e.textContent = '这个邮箱还没有提交过申请。'
        box.appendChild(e)
      }
      me.applications.forEach(function (a) {
        var s = document.createElement('div')
        s.className = 'status'
        var badge = document.createElement('span')
        badge.className = 'badge b-' + a.status
        badge.textContent = LABEL[a.status] || a.status
        s.appendChild(badge)
        var p = document.createElement('p')
        p.className = 'muted'
        p.textContent = '申请日期：' + fmt(a.createdAt) + (a.decidedAt ? '　审核日期：' + fmt(a.decidedAt) : '')
        s.appendChild(p)
        if (a.publicNote) {
          var q = document.createElement('p')
          q.textContent = '说明：' + a.publicNote
          s.appendChild(q)
        }
        box.appendChild(s)
      })
      if (me.reapplyAt) {
        var r = document.createElement('p')
        r.className = 'muted'
        r.textContent = '可在 ' + fmt(me.reapplyAt) + ' 之后重新申请。'
        box.appendChild(r)
      }
      if (me.canApply && mode !== 'apply') {
        var l = document.createElement('a')
        l.href = '/apply' + (ref ? '?ref=' + encodeURIComponent(ref) : '')
        l.textContent = '提交加入申请'
        box.appendChild(l)
      }
      if (!me.open && !m) {
        var pz = document.createElement('p')
        pz.className = 'muted'
        pz.textContent = cfg.texts.paused
        box.appendChild(pz)
      }
    }
    steps(2)
  }

  function restore() {
    msg('正在恢复…', 'info')
    api('POST', '/api/public/restore', {}).then(function (j) {
      if (!j.ok) return msg(j.reason || '恢复失败', 'err')
      me = j
      msg('已撤销注销，账号已恢复。登录权限恢复可能需要几分钟。', 'ok')
      renderStatus()
    })
  }
  function acceptInvite() {
    if (!inviteToken) return
    msg('正在接受邀请…', 'info')
    api('POST', '/api/public/invite/accept', { token: inviteToken }).then(function (j) {
      if (!j.ok) return msg(j.reason || '接受邀请失败', 'err')
      me = j
      msg(j.already ? '这封邀请已经接受过了。' : '已接受邀请，账号已开通（Standard）。', 'ok')
      renderStatus()
    })
  }

  $('send').onclick = function () {
    var email = $('email').value.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      msg('请输入正确的邮箱地址。', 'err')
      $('email').focus()
      return
    }
    if (cfg.turnstileSiteKey && !tsToken) {
      msg('请先完成人机验证。', 'err')
      return
    }
    var btn = $('send')
    btn.disabled = true
    api('POST', '/api/public/otp', {
      email: email,
      purpose: mode === 'account' ? 'restore' : mode,
      turnstile: tsToken,
    }).then(function (j) {
      if (tsWidget !== null && window.turnstile) {
        window.turnstile.reset(tsWidget)
        tsToken = ''
      }
      if (!j.ok) {
        btn.disabled = false
        return msg(j.reason || '发送失败，请稍后再试', 'err')
      }
      msg('如果邮箱可用，验证码已发出，请查收（也看看垃圾邮件）。', 'ok')
      $('code').disabled = false
      $('verify').disabled = false
      $('code').focus()
      var left = 60
      var t = setInterval(function () {
        left--
        btn.textContent = left > 0 ? left + ' 秒后重发' : '重新发送'
        if (left <= 0) {
          clearInterval(t)
          btn.disabled = false
        }
      }, 1000)
    })
  }
  $('f-verify').onsubmit = function (e) {
    e.preventDefault()
    var code = $('code').value.trim()
    if (!/^\d{6}$/.test(code)) {
      msg('验证码是 6 位数字。', 'err')
      return
    }
    $('verify').disabled = true
    api('POST', '/api/public/verify', { email: $('email').value.trim(), code: code }).then(function (j) {
      $('verify').disabled = false
      if (!j.ok) return msg(j.reason || '验证码不正确', 'err')
      msg('', '')
      return api('GET', '/api/public/me').then(function (s) {
        if (s.ok) {
          me = s
          showVerified()
        } else msg(s.reason || '请重试', 'err')
      })
    })
  }
  $('f-apply').onsubmit = function (e) {
    e.preventDefault()
    if (ref && !$('consent').checked) {
      msg('使用推荐链接需要勾选同意。', 'err')
      $('consent').focus()
      return
    }
    $('submit').disabled = true
    api('POST', '/api/public/apply', {
      note: $('note').value,
      ref: ref || undefined,
      consent: ref ? true : undefined,
    }).then(function (j) {
      $('submit').disabled = false
      if (!j.ok) {
        if (j.error === 'bad_ref' || j.error === 'self_ref') {
          ref = ''
          $('consentRow').classList.add('hidden')
          $('refbox').className = 'msg'
        }
        return msg(j.reason || '提交失败', 'err')
      }
      me = j
      $('f-apply').classList.add('hidden')
      msg(cfg.texts.success, 'ok')
      renderStatus()
    })
  }

  api('GET', '/api/public/config').then(function (c) {
    if (!c.ok) return msg('服务暂时不可用，请稍后再试。', 'err')
    cfg = c
    setTexts()
    if (ref && mode === 'apply') {
      api('GET', '/api/public/ref?t=' + encodeURIComponent(ref)).then(function (r) {
        var box = $('refbox')
        if (r.valid) {
          box.textContent = '你正在通过同学的推荐链接申请。'
          box.className = 'msg show info'
        } else {
          box.textContent = '这个推荐链接已失效，仍可直接申请。'
          box.className = 'msg show err'
          ref = ''
        }
      })
    }
    if (mode === 'apply' && !cfg.open) $('steps').classList.add('hidden')
    renderTurnstile()
    api('GET', '/api/public/me').then(function (s) {
      if (s.ok) {
        me = s
        $('email').value = s.email
        showVerified()
      }
    })
  })
})()
