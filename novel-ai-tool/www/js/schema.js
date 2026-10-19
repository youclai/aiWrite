/* 数据模型与迁移：单一事实来源，App 运行时与 Node 测试共用 */
(function (root) {
  'use strict';

  // 迁移步骤两种形态：
  //   { sql: '...' }        普通语句，在事务内执行
  //   { fts: ['...', ...] }  FTS5 相关，运行前探测能力，不支持则整组跳过并置降级标记
  var MIGRATIONS = [
    {
      version: 1,
      name: '基线：书架 / 章节 / 角色卡 / 模板 / 设置 / 快照 / AI 用量',
      up: [
        { sql: "CREATE TABLE books (" +
               "id INTEGER PRIMARY KEY AUTOINCREMENT," +
               "title TEXT NOT NULL," +
               "author TEXT NOT NULL DEFAULT ''," +
               "synopsis TEXT NOT NULL DEFAULT ''," +
               "style_note TEXT NOT NULL DEFAULT ''," +
               "created_at INTEGER NOT NULL," +
               "updated_at INTEGER NOT NULL)" },
        { sql: "CREATE TABLE chapters (" +
               "id INTEGER PRIMARY KEY AUTOINCREMENT," +
               "book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE," +
               "idx INTEGER NOT NULL," +
               "title TEXT NOT NULL DEFAULT ''," +
               "body TEXT NOT NULL DEFAULT ''," +
               "summary TEXT NOT NULL DEFAULT ''," +
               "word_count INTEGER NOT NULL DEFAULT 0," +
               "created_at INTEGER NOT NULL," +
               "updated_at INTEGER NOT NULL)" },
        { sql: 'CREATE INDEX idx_chapters_book ON chapters(book_id, idx)' },
        { sql: "CREATE TABLE characters (" +
               "id INTEGER PRIMARY KEY AUTOINCREMENT," +
               "book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE," +
               "name TEXT NOT NULL," +
               "role TEXT NOT NULL DEFAULT ''," +
               "aliases TEXT NOT NULL DEFAULT '[]'," +
               "personality TEXT NOT NULL DEFAULT ''," +
               "speech_style TEXT NOT NULL DEFAULT ''," +
               "taboos TEXT NOT NULL DEFAULT ''," +
               "background TEXT NOT NULL DEFAULT ''," +
               "created_at INTEGER NOT NULL," +
               "updated_at INTEGER NOT NULL)" },
        { sql: "CREATE TABLE templates (" +
               "id INTEGER PRIMARY KEY AUTOINCREMENT," +
               "kind TEXT NOT NULL," +
               "name TEXT NOT NULL," +
               "instruction TEXT NOT NULL," +
               "use_summary INTEGER NOT NULL DEFAULT 0," +
               "is_builtin INTEGER NOT NULL DEFAULT 0," +
               "sort_order INTEGER NOT NULL DEFAULT 0," +
               "created_at INTEGER NOT NULL," +
               "updated_at INTEGER NOT NULL)" },
        { sql: 'CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)' },
        { sql: "CREATE TABLE snapshots (" +
               "id INTEGER PRIMARY KEY AUTOINCREMENT," +
               "chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE," +
               "book_id INTEGER NOT NULL," +
               "body TEXT NOT NULL," +
               "word_count INTEGER NOT NULL DEFAULT 0," +
               "reason TEXT NOT NULL DEFAULT ''," +
               "created_at INTEGER NOT NULL)" },
        { sql: 'CREATE INDEX idx_snapshots_chapter ON snapshots(chapter_id, created_at DESC)' },
        { sql: "CREATE TABLE ai_jobs (" +
               "id INTEGER PRIMARY KEY AUTOINCREMENT," +
               "book_id INTEGER," +
               "chapter_id INTEGER," +
               "kind TEXT NOT NULL," +
               "provider TEXT NOT NULL DEFAULT ''," +
               "model TEXT NOT NULL DEFAULT ''," +
               "status TEXT NOT NULL DEFAULT 'running'," +
               "prompt_chars INTEGER NOT NULL DEFAULT 0," +
               "output_chars INTEGER NOT NULL DEFAULT 0," +
               "error TEXT NOT NULL DEFAULT ''," +
               "created_at INTEGER NOT NULL," +
               "finished_at INTEGER)" },
        // 内置模板：{kind} 占位由前端动作条使用，此处只存指令正文
        { sql: "INSERT INTO templates (kind,name,instruction,is_builtin,sort_order,created_at,updated_at) VALUES " +
               "('polish','润色','在保持原意、人称与人名一致的前提下润色下文，消除口语化赘词，不要添加新情节。',1,1,0,0)," +
               "('expand','扩写','把下文扩写到约两倍长度，补充动作与心理细节，不改变既有情节走向。',1,2,0,0)," +
               "('condense','缩写','把下文压缩到约一半长度，保留关键情节与所有伏笔信息。',1,3,0,0)," +
               "('dialogue','改对白','只重写下文中的对白，使其符合各角色的说话风格与禁忌设定，叙述部分保持原样。',1,4,0,0)," +
               "('continue','续写','承接下文结尾续写 300 字左右，不总结、不预告后事、不改变已确立的事实。',1,5,0,0)," +
               "('consistency','一致性检查','逐条检查下文中的人设崩塌、称呼不一致、时间线矛盾、视角越界与设定冲突。',1,6,0,0)" }
      ]
    },
    {
      version: 2,
      name: '一致性报告 / 伏笔 / 时间线 / 摘要模板',
      up: [
        { sql: "CREATE TABLE consistency_issues (" +
               "id INTEGER PRIMARY KEY AUTOINCREMENT," +
               "book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE," +
               "chapter_id INTEGER," +
               "job_id INTEGER," +
               "quote TEXT NOT NULL DEFAULT ''," +
               "type TEXT NOT NULL DEFAULT ''," +
               "problem TEXT NOT NULL," +
               "suggestion TEXT NOT NULL DEFAULT ''," +
               "status TEXT NOT NULL DEFAULT 'open'," +
               "created_at INTEGER NOT NULL)" },
        { sql: 'CREATE INDEX idx_issues_book ON consistency_issues(book_id, status)' },
        { sql: "CREATE TABLE plot_threads (" +
               "id INTEGER PRIMARY KEY AUTOINCREMENT," +
               "book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE," +
               "title TEXT NOT NULL," +
               "detail TEXT NOT NULL DEFAULT ''," +
               "planted_chapter_id INTEGER," +
               "status TEXT NOT NULL DEFAULT 'open'," +
               "payoff_chapter_id INTEGER," +
               "due_hint TEXT NOT NULL DEFAULT ''," +
               "created_at INTEGER NOT NULL," +
               "updated_at INTEGER NOT NULL)" },
        { sql: 'CREATE INDEX idx_threads_book_status ON plot_threads(book_id, status)' },
        { sql: "CREATE TABLE timeline_events (" +
               "id INTEGER PRIMARY KEY AUTOINCREMENT," +
               "book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE," +
               "when_label TEXT NOT NULL DEFAULT ''," +
               "chapter_id INTEGER," +
               "title TEXT NOT NULL," +
               "detail TEXT NOT NULL DEFAULT ''," +
               "character_names TEXT NOT NULL DEFAULT ''," +
               "sort_key TEXT NOT NULL DEFAULT ''," +
               "created_at INTEGER NOT NULL)" },
        { sql: 'CREATE INDEX idx_timeline_sort ON timeline_events(book_id, sort_key)' },
        { sql: "INSERT INTO templates (kind,name,instruction,is_builtin,sort_order,created_at,updated_at) " +
               "VALUES ('summary','章节摘要','用 80 字左右概括本章事件与情绪走向，只列事实与关键转折，不评价。',1,7,0,0)" }
      ]
    },
    {
      version: 3,
      name: '势力介绍（书内设定：门派/国家/组织等阵营）',
      up: [
        { sql: "CREATE TABLE factions (" +
               "id INTEGER PRIMARY KEY AUTOINCREMENT," +
               "book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE," +
               "name TEXT NOT NULL," +
               "kind TEXT NOT NULL DEFAULT ''," +
               "intro TEXT NOT NULL DEFAULT ''," +
               "created_at INTEGER NOT NULL," +
               "updated_at INTEGER NOT NULL)" },
        { sql: 'CREATE INDEX idx_factions_book ON factions(book_id, name)' }
      ]
    },
    {
      version: 4,
      name: '节（章的下级写作单元：章 > 节）',
      up: [
        { sql: "CREATE TABLE sections (" +
               "id INTEGER PRIMARY KEY AUTOINCREMENT," +
               "chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE," +
               "book_id INTEGER NOT NULL," +
               "idx INTEGER NOT NULL," +
               "title TEXT NOT NULL DEFAULT ''," +
               "body TEXT NOT NULL DEFAULT ''," +
               "summary TEXT NOT NULL DEFAULT ''," +
               "word_count INTEGER NOT NULL DEFAULT 0," +
               "created_at INTEGER NOT NULL," +
               "updated_at INTEGER NOT NULL)" },
        { sql: 'CREATE INDEX idx_sections_chapter ON sections(chapter_id, idx)' }
      ]
    },
    {
      // 内置模板文案富化（修改建议 7）：不改既有语义，只把“期望输出与粒度”写清楚；
      // 只动 is_builtin=1 的行，用户自建/改过的模板绝不覆盖。
      version: 5,
      name: '内置模板文案富化（明确期望输出与粒度）',
      up: [
        { sql: "UPDATE templates SET instruction='在保持原意、人称与人名一致的前提下润色下文，消除口语化赘词，不要添加新情节。只输出润色后的正文，不要解释、不加标题。' WHERE kind='polish' AND is_builtin=1" },
        { sql: "UPDATE templates SET instruction='把下文扩写到约两倍长度，补充动作与心理细节，不改变既有情节走向。只输出扩写后的正文，不要附写作说明。' WHERE kind='expand' AND is_builtin=1" },
        { sql: "UPDATE templates SET instruction='把下文压缩到约一半长度，保留关键情节与所有伏笔信息。只输出压缩后的正文。' WHERE kind='condense' AND is_builtin=1" },
        { sql: "UPDATE templates SET instruction='只重写下文中的对白，使其符合各角色的说话风格与禁忌设定，叙述部分保持原样。只输出改写后的文本，不要添加解释。' WHERE kind='dialogue' AND is_builtin=1" },
        { sql: "UPDATE templates SET instruction='承接下文结尾续写 300 字左右，不总结、不预告后事、不改变已确立的事实。只输出续写正文。' WHERE kind='continue' AND is_builtin=1" },
        { sql: "UPDATE templates SET instruction='逐条检查下文中的人设崩塌、称呼不一致、时间线矛盾、视角越界与设定冲突。每条输出含 quote（原文片段）、type（类型）、problem（问题）、suggestion（建议）的 JSON 数组。' WHERE kind='consistency' AND is_builtin=1" },
        { sql: "UPDATE templates SET instruction='用 80 字左右概括本章：分点列出主要事件、关键转折、情绪走向，只列事实，不评价。' WHERE kind='summary' AND is_builtin=1" }
      ]
    }
  ];

  // FTS5 外部内容表 + 三个同步触发器。分词器必须选对：
  //   unicode61 会把连续中文当成单一 token，中文子串查不到；trigram 才能做中文子串匹配（需 SQLite 3.34+，且查询至少 3 字）
  // 因此按 trigram → unicode61 → LIKE 三级能力探测。
  var FTS_TABLE = 'chapters_fts';
  function ftsStatements(tokenizer) {
    return [
      "CREATE VIRTUAL TABLE " + FTS_TABLE + " USING fts5(title, body, content=chapters, content_rowid=id, " +
        "tokenize='" + tokenizer + "')",
      'CREATE TRIGGER chapters_fts_ai AFTER INSERT ON chapters BEGIN ' +
        "INSERT INTO " + FTS_TABLE + "(rowid, title, body) VALUES (new.id, new.title, new.body); END;",
      'CREATE TRIGGER chapters_fts_ad AFTER DELETE ON chapters BEGIN ' +
        "INSERT INTO " + FTS_TABLE + "(" + FTS_TABLE + ", rowid, title, body) " +
        "VALUES('delete', old.id, old.title, old.body); END;",
      'CREATE TRIGGER chapters_fts_au AFTER UPDATE ON chapters BEGIN ' +
        "INSERT INTO " + FTS_TABLE + "(" + FTS_TABLE + ", rowid, title, body) " +
        "VALUES('delete', old.id, old.title, old.body); " +
        "INSERT INTO " + FTS_TABLE + "(rowid, title, body) VALUES (new.id, new.title, new.body); END;"
    ];
  }

  // 探测顺序决定最终能力标记
  var FTS_PROBES = [
    { mode: 'trigram', sql: "CREATE VIRTUAL TABLE _fts_probe USING fts5(x, tokenize='trigram')" },
    { mode: 'fts5', sql: 'CREATE VIRTUAL TABLE _fts_probe USING fts5(x)' }
  ];

  var LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

  var DEFAULT_SETTINGS = {
    ai_context: {
      use_summary: false,
      inject_taboos: true,
      inject_prev_summary: false,
      check_scope: 'chapter',
      token_budget: 6000,
      auto_adopt: false          // 写死 false：界面不提供开关
    },
    // API 连接配置：这里只存"非敏感"字段。provider/base_url/model 可入明文库；
    // 真正的 api_key 绝不进本表，只经 NOVEL_SECURE 以 AES-GCM 密文落在 Preferences（F50）。
    api: {
      provider: 'mock',          // openai_chat | anthropic | custom | mock
      base_url: '',              // custom/兼容服务的地址；provider 预设时可自动填
      model: '',
      key_set: false             // 仅标记"是否已配置密钥"，布尔值本身不敏感；密钥在 SecureStore
    },
    // 派生/暂存数据策略：一切二次产物只落在私有目录 temp/ 根内并分类归档（NOVEL_TEMP）
    storage: {
      temp_root: 'temp',         // 唯一根目录名，主数据(SQLite)与派生数据物理隔离
      temp_auto_clean: true,     // 回前台/定时清理过期一次性产物
      temp_keep_days: 7          // preview/ai/import/logs 类暂存保留天数；backup 另按滚动 10 份
    },
    appearance: {
      font_size: 17,
      line_height: 1.9,
      para_indent: true,
      theme: 'paper',            // paper | light | dark
      content_width: 720
    }
  };

  root.NOVEL_SCHEMA = {
    MIGRATIONS: MIGRATIONS,
    LATEST_VERSION: LATEST_VERSION,
    FTS_TABLE: FTS_TABLE,
    ftsStatements: ftsStatements,
    FTS_PROBES: FTS_PROBES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS
  };
})(globalThis);
