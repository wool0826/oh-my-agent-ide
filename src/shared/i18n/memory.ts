// The Memory view: UI text in English and Korean. Merged in ../i18n.ts.

export const en = {
  // memory
  'mem.search': 'Search memory',
  'mem.emptyTitle': 'Memory is empty',
  'mem.pickTitle': 'Pick a memory file',
  'mem.promote': 'PR to CLAUDE.md',
  'mem.promoteHint': 'Ask a Worker to open a PR adding these repo notes to its CLAUDE.md',
  'mem.prefTitle': 'Preferences and principles',
  'mem.prefIntro': 'Preferences and recurring principles the user has stated. The Dispatcher uses them to answer on the user\'s behalf.',
  'mem.repoTitle': '{name} repository',
  'mem.decTitle': 'Decisions {month}',
  'mem.taskTitle': 'Tasks {month}',
  'mem.notesTitle': 'Notes',
  'mem.corrected': 'corrected',
  'mem.err.outside': 'Only files inside the memory folder can be opened.',
};

export const ko: Record<keyof typeof en, string> = {
  'mem.search': '메모리 검색',
  'mem.emptyTitle': '메모리가 비어 있어요',
  'mem.pickTitle': '메모리 파일을 고르세요',
  'mem.promote': 'CLAUDE.md 반영 PR',
  'mem.promoteHint': '이 저장소 메모를 CLAUDE.md에 반영하는 PR을 Worker에게 맡겨요',
  'mem.prefTitle': '선호와 원칙',
  'mem.prefIntro': '사용자가 밝힌 선호, 반복해서 쓰는 원칙을 적습니다. Dispatcher가 대신 답할 때 근거로 씁니다.',
  'mem.repoTitle': '{name} 저장소',
  'mem.decTitle': '{month} 결정',
  'mem.taskTitle': '{month} 작업',
  'mem.notesTitle': '메모',
  'mem.corrected': '정정',
  'mem.err.outside': '메모리 폴더 안의 파일만 열 수 있어요.',
};
