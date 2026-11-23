import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// Mod « roles » : une fiche de rôle par session Claude Code.
// Le rôle est attaché à l'identifiant de la session, pas à son nom : un
// /rename ne le change pas. `/role <nom>` donne le rôle (et, par commodité,
// renomme la session) : la fiche « .claude/roles/<nom>.md », cherchée en remontant depuis le
// dossier de la session (le plus proche l'emporte), passée comme un fichier
// d'instructions : présente au démarrage, à la reprise, après un résumé de
// contexte, renvoyée quand elle change sur disque.

type Fiche = { name: string; path: string; text: string; mtimeMs: number }

const TITLE = /"customTitle":("(?:[^"\\]|\\.)*")/g
const CHUNK = 4 * 1024 * 1024
const BEAT_MS = 5000
const STALE_MS = 30000
const PANE = 'roles'
const filter = atom({ plugin: 'roles', key: 'filter' } as const, '', { shape: 'filter-1' })

// creating : le rôle dont la session rédige la fiche ; pris dès que le fichier existe.
const S: { role?: string; pending?: string; creating?: string; fiche: Fiche | null; dir: string; sid: string; home: string } = {
  pending: undefined, role: undefined, creating: undefined, fiche: null, dir: '', sid: '', home: '',
}

function key(name: string) {
  return name.normalize('NFC').toLowerCase()
}

async function lastTitle($: any, path: string): Promise<string | undefined> {
  if (!path || !(await $.fs.exists(path))) return undefined
  let end = (await $.fs.stat(path)).size
  while (end > 0) {
    const offset = Math.max(0, end - CHUNK)
    const text: string = await $.fs.read(path, { offset, length: end - offset })
    const found = [...text.matchAll(TITLE)].at(-1)
    if (found?.[1]) return JSON.parse(found[1])
    end = offset
  }
  return undefined
}

// Les arguments de lancement du processus claude (Linux) : -n/--name, --resume.
async function launchArgs($: any): Promise<string[]> {
  try {
    return (await $.fs.read('/proc/self/cmdline')).split('\u0000')
  } catch {
    return []
  }
}

// Le nom de la session : le dernier « customTitle » de son transcript ; avant
// que le transcript existe (1er tour, fork), le -n du lancement ou le titre de
// la session reprise.
async function readTitle($: any): Promise<string | undefined> {
  const { transcriptPath } = await $.session.info()
  const own = await lastTitle($, transcriptPath)
  if (own) return own
  const args = await launchArgs($)
  const at = (flags: string[]) => {
    const i = args.findIndex(one => flags.includes(one))
    return i >= 0 ? args[i + 1] : undefined
  }
  const named = at(['-n', '--name'])
  if (named) return named
  const resumed = at(['-r', '--resume'])
  if (resumed && /^[0-9a-f-]{36}$/.test(resumed) && transcriptPath) {
    return lastTitle($, transcriptPath.replace(/[^/]+$/, `${resumed}.jsonl`))
  }
  return undefined
}

// Les rôles disponibles : les fiches du dossier, hors « _MODELE.md » et autres « _… ».
async function roles($: any): Promise<string[]> {
  if (!S.dir || !(await $.fs.exists(S.dir))) return []
  return (await $.fs.list(S.dir))
    .filter((one: any) => one.kind === 'file' && one.name.endsWith('.md') && !one.name.startsWith('_'))
    .map((one: any) => one.name.slice(0, -3).normalize('NFC'))
    .sort((a: string, b: string) => a.localeCompare(b, 'fr'))
}

async function findRole($: any, name: string | undefined): Promise<string | undefined> {
  if (!name) return undefined
  return (await roles($)).find(one => key(one) === key(name))
}

async function readFiche($: any, name: string | undefined): Promise<Fiche | null> {
  const role = await findRole($, name)
  if (!role) return null
  const entry = (await $.fs.list(S.dir)).find((one: any) => key(one.name) === key(`${role}.md`))
  const path = `${S.dir}/${entry.name}`
  const { mtimeMs } = await $.fs.stat(path)
  return { name: role, path, text: await $.fs.read(path), mtimeMs }
}

// Qui tient quel rôle : un fichier par rôle, rafraîchi toutes les 5 s par la
// session qui le tient, dans ~/.local/state/fiche-role (commun à tous les profils).
function holderPath(role: string) {
  return `${S.home}/.local/state/fiche-role/${encodeURIComponent(`${S.dir}/${key(role)}`)}.json`
}

// Le dossier des fiches : le premier « .claude/roles » en remontant depuis le
// dossier de la session ; '' s'il n'y en a aucun.
async function findDir($: any): Promise<string> {
  let dir: string = await $.session.cwd()
  while (dir) {
    const here = `${dir === '/' ? '' : dir}/.claude/roles`
    if (await $.fs.exists(here)) return here
    if (dir === '/') return ''
    dir = dir.replace(/\/[^/]*$/, '') || '/'
  }
  return ''
}

// Le rôle de chaque session : ~/.local/state/fiche-role/sessions/<id>.json.
function bindingPath(sid: string) {
  return `${S.home}/.local/state/fiche-role/sessions/${sid}.json`
}

async function readBinding($: any, sid: string): Promise<string | undefined> {
  const path = bindingPath(sid)
  if (!sid || !(await $.fs.exists(path))) return undefined
  return JSON.parse(await $.fs.read(path)).role
}

async function bind($: any, role: string) {
  await $.fs.write(bindingPath(S.sid), JSON.stringify({ role, dir: S.dir, at: await $.clock.now() }))
  S.role = role
}

// Au démarrage : le rôle lié à cet identifiant ; sinon celui de la session
// reprise (fork, nouvel identifiant) ; sinon, une seule fois, le nom de la
// session s'il a une fiche (sessions nommées avant ce mod). Le lien est écrit.
async function loadRole($: any) {
  S.role = await readBinding($, S.sid)
  if (S.role) return
  const args = await launchArgs($)
  const i = args.findIndex(one => one === '-r' || one === '--resume')
  const resumed = i >= 0 ? args[i + 1] : undefined
  const inherited = resumed && resumed !== S.sid ? await readBinding($, resumed) : undefined
  const role = inherited ?? (await findRole($, await readTitle($)))
  if (role) await bind($, role)
}

async function otherHolder($: any, role: string): Promise<string | undefined> {
  const path = holderPath(role)
  if (!(await $.fs.exists(path))) return undefined
  const held = JSON.parse(await $.fs.read(path))
  const isFresh = (await $.clock.now()) - held.at < STALE_MS
  return isFresh && held.sid !== S.sid ? held.sid : undefined
}

async function beat($: any) {
  if (!S.fiche || !S.home) return
  if (await otherHolder($, S.fiche.name)) return
  await $.fs.write(holderPath(S.fiche.name), JSON.stringify({ sid: S.sid, at: await $.clock.now() }))
}

async function tick($: any) {
  if (S.pending) {
    await $.command.run({ command: 'rename', args: S.pending }).catch((err: any) => $.ui.toast(`roles : /rename refusé (${String(err)})`))
    const read = await readTitle($)
    if (read && key(read) === key(S.pending)) S.pending = undefined
  }
  await refresh($)
  await beat($)
}

function ficheText() {
  return `# Fiche de rôle de la session « ${S.fiche!.name} »\n` +
    `(source : ${S.fiche!.path} ; garde ce rôle, même après un résumé de contexte)\n\n${S.fiche!.text}`
}

async function showStatus($: any) {
  if (!S.dir) return $.ui.status(undefined)
  if (!S.fiche) return $.ui.status(S.role ? `⚠ rôle « ${S.role} » : fiche introuvable dans ${S.dir}` : '⚠ pas de rôle : /role <nom>')
  const twin = await otherHolder($, S.fiche.name)
  $.ui.status(twin ? `⚠ rôle « ${S.fiche.name} » tenu aussi par ${twin.slice(0, 8)}` : `rôle : ${S.fiche.name}`)
}

// Relit la fiche du rôle ; si elle a changé, la redemande au moteur.
async function refresh($: any) {
  if (!S.dir) S.dir = await findDir($)
  if (S.creating && (await findRole($, S.creating))) {
    const made = (await findRole($, S.creating))!
    S.creating = undefined
    await take($, made)
    $.ui.toast(`Fiche « ${made} » créée : rôle pris.`)
  }
  S.role = await readBinding($, S.sid)
  const next = await readFiche($, S.role)
  const isChanged = next?.path !== S.fiche?.path || next?.mtimeMs !== S.fiche?.mtimeMs
  S.fiche = next
  await showStatus($)
  if (isChanged) $.ui.invalidate('prompt.context')
  return isChanged
}

// Donne le rôle (déjà vérifié) à cette session et la renomme.
async function take($: any, role: string) {
  await bind($, role)
  S.pending = role
  S.fiche = await readFiche($, role)
  await showStatus($)
  $.ui.invalidate('prompt.context')
}

// Fait rédiger la fiche par la session, avec la personne, d'après le gabarit du dossier.
async function create($: any, name: string) {
  const dir = S.dir || `${await $.session.root()}/.claude/roles`
  S.creating = name
  const model = (await $.fs.exists(`${dir}/_MODELE.md`)) ? `le gabarit ${dir}/_MODELE.md` : 'un gabarit court (rôle en une phrase, périmètre, hors périmètre, superviseur, gestes qui demandent mon accord direct)'
  await $.prompt.submit({
    text: `Rédige avec moi la fiche de rôle « ${name} » de cette session, d'après ${model} et une ou deux fiches voisines de ${dir} s'il y en a. ` +
      `Pose-moi d'abord tes questions (rôle, périmètre, hors périmètre, superviseur, accords), puis montre-moi le texte. ` +
      `Après mon accord seulement, écris-le dans « ${dir}/${name}.md » : le mod roles donne alors ce rôle à la session tout seul.`,
  })
}

// Un nom choisi dans le panneau ou tapé après /role : rôle existant, ou proposition de le créer.
async function choose($: any, asked: string): Promise<string> {
  const name = asked.trim()
  if (!name) return ''
  const role = await findRole($, name)
  if (role) {
    const twin = await otherHolder($, role)
    await take($, role)
    const warn = twin ? `\n⚠ La session ${twin} tient déjà ce rôle : les messages adressés à « ${role} » risquent d'arriver à l'une ou l'autre.` : ''
    return `Rôle « ${role} » donné à cette session (${S.sid.slice(0, 8)}) : elle prend ce nom et reçoit ${S.fiche!.path}. Un /rename ultérieur ne change pas le rôle.${warn}`
  }
  const answer = await $.ui.ask(`Pas de fiche « ${name} ». La créer avec cette session ?`, { options: ['Créer la fiche', 'Annuler'], header: 'Rôle' }).catch(() => 'Annuler')
  if (answer !== 'Créer la fiche') return `Pas de fiche « ${name} » : rien n'est changé.\n\n${await listText($)}`
  await create($, name)
  return `Fiche « ${name} » : la session la rédige avec toi ; le rôle est pris dès que le fichier existe.`
}

async function pick($: any, name: string) {
  await $.ui.close({ id: PANE })
  await update($, filter, () => '')
  const text = await choose($, name)
  if (text) $.ui.toast(text.split('\n')[0])
}

async function listText($: any) {
  const all = await roles($)
  if (!S.dir) return `Aucun dossier .claude/roles au-dessus de ${await $.session.cwd()} : /role <nom> propose d'en créer la fiche.`
  return all.length ? `Rôles disponibles :\n${all.map(one => `- ${one}`).join('\n')}` : `Aucune fiche dans ${S.dir} : /role <nom> propose d'en créer une.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    S.dir = await findDir($)
    S.home = (await $.env.get('HOME')) ?? ''
    S.sid = await $.session.id()
    await loadRole($)
    await $.command.register({
      name: 'role',
      description: 'Donne un rôle à cette session (/role <nom>), ou montre le sien',
      argumentHint: '<nom>',
    })
    await refresh($)
    // Une fiche modifiée sur disque est vue dans les 5 s.
    $.clock.every(BEAT_MS, () => void tick($))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await refresh($).catch(() => undefined)
    return next(e)
  })

  on('prompt.context', async ($, e, next) => {
    const out = await next(e)
    await refresh($)
    if (!S.fiche) return out
    const files = (out.instructionFiles ?? e.instructionFiles ?? []).filter(
      (one: any) => one.path !== S.fiche!.path,
    )
    return { ...out, instructionFiles: [...files, { path: S.fiche.path, kind: 'user', content: ficheText() }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (S.fiche || !S.dir || e.props.hasSurvey) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text color="warning">Pas de rôle : /role &lt;nom&gt; (/role seul liste les rôles)</Text>
  })

  // /role seul : le panneau de choix (ou, sans écran, la fiche et la liste).
  // /role <nom> : ce rôle, ou la proposition de créer sa fiche.
  // Le /rename vers le rôle part de la minuterie (d'ici, il attendrait ce tour).
  on('command.run', { command: 'role' }, async ($, e) => {
    await refresh($)
    const asked = e.args.trim()
    if (!asked) {
      const opened = await $.ui.open({ id: PANE, title: 'Rôle de cette session', focus: true, closeOnEscape: true })
      const now = S.fiche ? `Rôle actuel : « ${S.fiche.name} » (${S.fiche.path}).` : 'Pas de rôle.'
      if (opened.isPlaced) return { text: `${now} Choisis ou tape un rôle dans le panneau (Échap pour fermer).`, isTextDisplayOnly: true }
      return { text: S.fiche ? `${now}\n\n${S.fiche.text}` : `${now}\n\n${await listText($)}` }
    }
    const text = await choose($, asked)
    return S.fiche && key(S.fiche.name) === key(asked) ? { text, context: [ficheText()] } : { text }
  })

  // « /role h… » : les rôles qui commencent ainsi, noms à espaces compris.
  on('prompt.autocomplete', async ($, e, next) => {
    const out = await next(e)
    if (!e.text.startsWith('/role ') || e.cursor < 7) return out
    const typed = e.text.slice(6, e.cursor)
    const mine = (await roles($))
      .filter(one => key(one).startsWith(key(typed)) && key(one) !== key(typed))
      .map(one => ({ text: one.slice(typed.length - e.token.length), label: one, description: 'rôle' }))
    return { suggestions: [...out.suggestions, ...mine] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const typed = await read($, filter)
    const all = await roles($)
    const shown = all.filter(one => key(one).includes(key(typed)))
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)
    const isNew = typed.trim() && !all.some(one => key(one) === key(typed.trim()))
    return (
      <Box flexDirection="column">
        <Text dimColor>{S.fiche ? `Rôle actuel : ${S.fiche.name}` : 'Pas de rôle'}{S.dir ? ` · ${S.dir}` : ' · aucun dossier .claude/roles'}</Text>
        <Input key="nom" label="Rôle : " placeholder="filtrer, ou nom d'un nouveau rôle" autoFocus submitLabel={isNew ? 'créer' : 'prendre'}
          value={typed}
          onInput={value => void update($, filter, () => value)}
          onSubmit={value => void pick($, shown.length === 1 && !isNew ? shown[0]! : value)} />
        {shown.slice(0, room).map(one => (
          <Button key={`role:${one}`} plain onPress={() => pick($, one)}>
            {one}{S.fiche && key(S.fiche.name) === key(one) ? <Text dimColor> (actuel)</Text> : ''}
          </Button>
        ))}
        {shown.length > room && <Text dimColor>… {shown.length - room} autres : tape pour filtrer</Text>}
        {isNew && <Text color="warning">Entrée : créer la fiche « {typed.trim()} »</Text>}
      </Box>
    )
  })
}
