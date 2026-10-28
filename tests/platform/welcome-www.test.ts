import { describe, expect, it } from 'vitest'
import welcome from '../../worker/welcome/entry'

describe('welcome www redirect', () => {
  it('www.<apex> answers 301 to the apex with the same path and query; the apex is served normally', async () => {
    const r = await welcome.fetch(new Request('https://www.getexampilot.site/apply?r=abc'), {} as never)
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('https://getexampilot.site/apply?r=abc')
    const a = await welcome.fetch(new Request('https://getexampilot.site/'), {} as never)
    expect(a.status).toBe(200)
  })
})
