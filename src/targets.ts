import type { Target } from "./types.ts";

const PY_MANIFESTS =
  /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile|poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock)$/;

export const TARGETS: Record<string, Target> = {
  pydantic: {
    name: "pydantic",
    fromMajor: 1,
    toMajor: 2,
    manifests: PY_MANIFESTS,
    source: /\.py$/,
    queries: [
      "pydantic v2 migration",
      "migrate to pydantic 2",
      "upgrade pydantic to v2",
      "bump pydantic 2",
      "pydantic 2 upgrade",
      "port to pydantic v2",
      "pydantic v2 compatibility",
      "fix pydantic v2",
    ],
    // Each pair is a real v1 → v2 API change. Tier noted in the comment:
    // t1 = pure rename, t2 = rename plus structure, t3 = semantics also change.
    markers: [
      { label: "validator", from: /@validator\b/, to: /@field_validator\b/ },             // t3
      { label: "root_validator", from: /@root_validator\b/, to: /@model_validator\b/ },   // t3
      { label: "dict", from: /\.dict\(/, to: /\.model_dump\(/ },                          // t1
      { label: "json", from: /\.json\(/, to: /\.model_dump_json\(/ },                     // t1
      { label: "parse_obj", from: /\.parse_obj\(/, to: /\.model_validate\(/ },             // t1
      { label: "parse_raw", from: /\.parse_raw\(/, to: /\.model_validate_json\(/ },        // t1
      { label: "config", from: /class Config\b/, to: /model_config\s*=/ },                 // t2
      { label: "allow_mutation", from: /allow_mutation/, to: /frozen\s*=/ },               // t3
      { label: "schema", from: /\.schema\(/, to: /\.model_json_schema\(/ },                // t1
      { label: "copy", from: /\.copy\(/, to: /\.model_copy\(/ },                           // t2
      { label: "forward_refs", from: /update_forward_refs/, to: /model_rebuild/ },          // t1
      { label: "basesettings", from: /from pydantic import[^\n]*BaseSettings/, to: /pydantic_settings/ }, // t2
      { label: "field_alias", from: /\bconst\s*=|\ballow_population_by_field_name/, to: /populate_by_name/ }, // t2
    ],
    repoQueries: [
      "fastapi language:python stars:>100 pushed:>2024-06-01",
      "pydantic language:python stars:>80 pushed:>2024-06-01",
      "language:python topic:fastapi stars:>100",
      "langchain language:python stars:>100 pushed:>2024-06-01",
    ],
  },

  sqlalchemy: {
    name: "sqlalchemy",
    fromMajor: 1,
    toMajor: 2,
    manifests: PY_MANIFESTS,
    source: /\.py$/,
    queries: [
      "sqlalchemy 2.0 migration",
      "upgrade sqlalchemy 2",
      "migrate to sqlalchemy 2.0",
      "bump sqlalchemy 2",
      "sqlalchemy 2.0 compatibility",
    ],
    markers: [
      { label: "query_to_select", from: /session\.query\(/, to: /select\(/ },
      { label: "declarative_base", from: /declarative_base\(/, to: /DeclarativeBase\b/ },
      { label: "execute_text", from: /\.execute\(\s*["']/, to: /text\(/ },
      { label: "session_get", from: /\.query\([^)]*\)\.get\(/, to: /session\.get\(/ },
      { label: "typing", from: /Column\(/, to: /mapped_column\(/ },
    ],
    repoQueries: [
      "sqlalchemy language:python stars:>80 pushed:>2024-06-01",
      "flask sqlalchemy language:python stars:>100",
      "language:python topic:sqlalchemy stars:>60",
    ],
  },

  openai: {
    name: "openai",
    fromMajor: 0,
    toMajor: 1,
    manifests: PY_MANIFESTS,
    source: /\.py$/,
    queries: [
      "openai python v1 migration",
      "migrate openai sdk 1.0",
      "upgrade openai to 1",
      "openai 1.0 compatibility",
    ],
    markers: [
      { label: "chat_completion", from: /openai\.ChatCompletion\.create/, to: /chat\.completions\.create/ },
      { label: "completion", from: /openai\.Completion\.create/, to: /completions\.create/ },
      { label: "client_object", from: /openai\.api_key\s*=/, to: /OpenAI\(/ },
      { label: "embeddings", from: /openai\.Embedding\.create/, to: /embeddings\.create/ },
      { label: "errors", from: /openai\.error\./, to: /openai\.(APIError|RateLimitError|APIStatusError)/ },
    ],
    repoQueries: [
      "openai language:python stars:>100 pushed:>2024-06-01",
      "language:python topic:openai stars:>80",
      "llm agent language:python stars:>150 pushed:>2024-06-01",
    ],
  },
};
