// Plain-language copy for the Add-on Manager's cards, keyed by plugin name.
// Anything not listed here falls back to the plugin's own description.
//
//   title    a short everyday name for the card
//   summary  one or two sentences on what it does for you
//   group    which section the card sits in (see GROUPS)
//   cost     'normal' | 'more' | 'lots': how fast it uses your Claude usage
//   tryIt    the first thing to type in a new chat, when there is one
//   notes    extra things worth knowing before installing
//   needs    tools it calls; the server checks each one is on this computer

export const GROUPS = [
  { id: 'everyday', title: 'Everyday coding' },
  { id: 'review', title: 'Reviews and safety' },
  { id: 'style', title: 'How Claude talks to you' },
  { id: 'advanced', title: 'Advanced' },
]

export const PLUGINS = {
  'commit-commands': {
    title: 'Commit helper',
    summary:
      'Saves your work in git for you. Claude looks at what you changed, writes the commit message and makes the commit.',
    group: 'everyday',
    cost: 'normal',
    tryIt: '/commit',
    needs: [{ tool: 'gh', why: 'only for /commit-push-pr, which opens a pull request on GitHub' }],
  },
  'feature-dev': {
    title: 'Feature builder',
    summary:
      'Walks you through building something new, step by step: understand the code, plan it, build it, then review it.',
    group: 'everyday',
    cost: 'more',
    tryIt: '/feature-dev',
    notes: ['Sends helper agents to read your code, so it uses more than a normal chat.'],
  },
  'frontend-design': {
    title: 'Design sense',
    summary:
      'Makes Claude better at designing web pages and app screens that look good. Works on its own whenever you ask for UI work.',
    group: 'everyday',
    cost: 'normal',
    notes: ['No command to type. Just ask for a page or screen as usual.'],
  },
  'code-review': {
    title: 'Pull request reviewer',
    summary:
      'Reviews a GitHub pull request and points out real bugs, filtering out weak guesses.',
    group: 'review',
    cost: 'lots',
    tryIt: '/code-review',
    notes: ['Runs several reviewers at the same time.'],
    needs: [{ tool: 'gh', why: 'to read the pull request from GitHub' }],
  },
  'pr-review-toolkit': {
    title: 'Review team',
    summary:
      'A team of specialist reviewers that check your changes for tests, error handling, comments, types and code that could be simpler.',
    group: 'review',
    cost: 'lots',
    tryIt: '/review-pr',
    notes: [
      'Reviews the changes on your computer. No GitHub needed.',
      'Runs several reviewers, so a full review uses a lot.',
    ],
  },
  'security-guidance': {
    title: 'Security guard',
    summary:
      'Warns about risky code, like unsafe HTML or shell commands, while Claude edits, and runs a security check when Claude finishes.',
    group: 'review',
    cost: 'more',
    notes: [
      'Works on its own. Nothing to type.',
      'Makes its own extra requests to Claude to check code, on your account.',
    ],
  },
  hookify: {
    title: 'House rules',
    summary:
      'Set your own rules, like "never delete files without asking", and Claude gets warned or stopped when it breaks one.',
    group: 'review',
    cost: 'normal',
    tryIt: '/hookify',
    needs: [{ tool: 'python3', why: 'to check your rules while Claude works' }],
  },
  'explanatory-output-style': {
    title: 'Explain as you go',
    summary:
      'Claude explains why it does things while it works, with short "insight" notes. Good for learning a codebase.',
    group: 'style',
    cost: 'normal',
    notes: ['Works on its own from the next chat. Replies get a bit longer.'],
  },
  'learning-output-style': {
    title: 'Learning mode',
    summary:
      'Claude asks you to write small pieces of code yourself at the important moments, and explains as it goes.',
    group: 'style',
    cost: 'normal',
    notes: ['Works on its own from the next chat.'],
  },
  'ralph-wiggum': {
    title: 'Keep-going loop',
    summary:
      'Keeps Claude working on the same task again and again until it is finished.',
    group: 'advanced',
    cost: 'lots',
    tryIt: '/ralph-loop "your task" --max-iterations 10',
    notes: [
      'Always give it a limit with --max-iterations, or it can run for a long time.',
      'Type /cancel-ralph to stop it.',
    ],
  },
  'plugin-dev': {
    title: 'Add-on builder',
    summary:
      'Helps you make your own add-ons. Claude asks what you want and builds it with you.',
    group: 'advanced',
    cost: 'more',
    tryIt: '/create-plugin',
  },
  'agent-sdk-dev': {
    title: 'Agent app starter',
    summary:
      'For programmers building their own AI agent apps with the Claude Agent SDK. Sets up a new project and checks it.',
    group: 'advanced',
    cost: 'normal',
    tryIt: '/new-sdk-app my-agent',
  },
  'claude-opus-4-5-migration': {
    title: 'Model upgrade helper',
    summary:
      'For programmers: updates code and prompts that use older Claude models so they work with Opus 4.5.',
    group: 'advanced',
    cost: 'normal',
    notes: ['Made for Opus 4.5. Newer models have come out since, so this one is mostly out of date.'],
  },
}

