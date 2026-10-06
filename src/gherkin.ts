import { readFileSync } from 'node:fs';
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';

export type AgentName = 'web' | 'android';
export type StepKind = 'action' | 'assertion';

export interface Step {
  keyword: string;
  kind: StepKind;
  agent: AgentName;
  text: string;
}

export interface Scenario {
  feature: string;
  name: string;
  tags: string[];
  steps: Step[];
}

const AGENT_PREFIX = /^\[(web|android)\]\s*/i;

function toStep(keyword: string, kind: StepKind, raw: string): Step {
  const match = AGENT_PREFIX.exec(raw);
  if (!match) {
    throw new Error(`Step is missing an [web] or [android] prefix: "${raw}"`);
  }
  return {
    keyword,
    kind,
    agent: match[1].toLowerCase() as AgentName,
    text: raw.replace(AGENT_PREFIX, ''),
  };
}

export function parseFeature(path: string): Scenario[] {
  return parseFeatureText(readFileSync(path, 'utf8'));
}

export function parseFeatureText(source: string): Scenario[] {
  const parser = new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher());
  const feature = parser.parse(source).feature;
  if (!feature) return [];

  const featureTags = feature.tags.map((t) => t.name);
  let background: Step[] = [];
  const scenarios: Scenario[] = [];

  for (const child of feature.children) {
    if (child.background) {
      background = toSteps(child.background.steps);
    } else if (child.scenario) {
      const { scenario } = child;
      const tags = [...featureTags, ...scenario.tags.map((t) => t.name)];
      const bgSteps = background;
      const base = toSteps(scenario.steps);
      const tables = scenario.examples.flatMap((ex) => {
        const header = ex.tableHeader?.cells.map((c) => c.value) ?? [];
        return ex.tableBody.map((row) => Object.fromEntries(header.map((h, i) => [h, row.cells[i].value])));
      });
      if (!tables.length) {
        scenarios.push({ feature: feature.name, name: scenario.name, tags, steps: [...bgSteps, ...base] });
      } else {
        // Scenario Outline: one scenario per Examples row, <column> placeholders substituted.
        for (const [i, row] of tables.entries()) {
          const fill = (t: string) => t.replace(/<([^>]+)>/g, (m, k) => row[k] ?? m);
          scenarios.push({
            feature: feature.name,
            name: fill(scenario.name) === scenario.name ? `${scenario.name} #${i + 1}` : fill(scenario.name),
            tags,
            steps: [...bgSteps, ...base.map((st) => ({ ...st, text: fill(st.text) }))],
          });
        }
      }
    }
  }
  return scenarios;
}

// "And"/"But" inherit the kind of the previous Given/When/Then.
function toSteps(
  steps: ReadonlyArray<{ keyword: string; text: string }>,
): Step[] {
  let kind: StepKind = 'action';
  return steps.map((s) => {
    const keyword = s.keyword.trim();
    if (keyword === 'Then') kind = 'assertion';
    else if (keyword === 'Given' || keyword === 'When') kind = 'action';
    return toStep(keyword, kind, s.text);
  });
}
