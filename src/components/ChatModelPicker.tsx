import { useEffect, useState } from 'react';
import { Bot, Sparkles } from 'lucide-react';
import { api } from '../api';
import { EFFORTS, EFFORT_LABELS } from '../workflow-types';

// 会话级模型选择：内置模型 Agent 用哪个模型配置、以及思考强度。
// 选择按对话存本地，下次打开同一对话自动恢复；留空表示沿用「规划设置」里的默认模型。

type Profile = { id: string; name: string; model: string; capabilities?: { efforts: string[] } };
export type ChatModelChoice = { profileId: string; effort: string };

const storageKey = (chatId: string) => `lagent.chatmodel.v1.${chatId}`;

export function readChatModel(chatId: string): ChatModelChoice {
  try {
    const raw = localStorage.getItem(storageKey(chatId));
    if (!raw) return { profileId: '', effort: 'default' };
    const parsed = JSON.parse(raw) as Partial<ChatModelChoice>;
    return {
      profileId: typeof parsed.profileId === 'string' ? parsed.profileId : '',
      effort: typeof parsed.effort === 'string' && parsed.effort ? parsed.effort : 'default',
    };
  } catch {
    return { profileId: '', effort: 'default' };
  }
}

export function writeChatModel(chatId: string, choice: ChatModelChoice) {
  try { localStorage.setItem(storageKey(chatId), JSON.stringify(choice)); } catch { /* 隐私模式下写不了，忽略。 */ }
}

export function ChatModelPicker({ chatId, value, onChange, disabled }: {
  chatId: string;
  value: ChatModelChoice;
  onChange: (next: ChatModelChoice) => void;
  disabled?: boolean;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [defaultName, setDefaultName] = useState('');
  const [defaultId, setDefaultId] = useState('');

  useEffect(() => {
    let alive = true;
    api.modelHub()
      .then(payload => {
        if (!alive) return;
        const list = payload.profiles || [];
        setProfiles(list);
        setDefaultName(list.find(item => item.id === payload.workflow?.defaultProfileId)?.name || '');
        setDefaultId(payload.workflow?.defaultProfileId || '');
      })
      .catch(() => { if (alive) setProfiles([]); });
    return () => { alive = false; };
  }, [chatId]);

  // 模型中心没配置时整块隐藏，避免给出一个选了也不生效的控件。
  if (!profiles.length) return null;

  const active = profiles.find(item => item.id === (value.profileId || defaultId)) || null;
  const supported = new Set(['default', ...(active?.capabilities?.efforts || [])]);

  return <div className="sa-modelbar" role="group" aria-label="模型设置">
    <label className="sa-chip">
      <Bot size={12} />
      <span>模型</span>
      <select
        aria-label="这个对话使用的模型"
        value={value.profileId}
        disabled={disabled}
        onChange={event => onChange({ profileId: event.target.value, effort: 'default' })}
      >
        <option value="">默认模型{defaultName ? ` · ${defaultName}` : ''}</option>
        {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name === profile.model ? profile.name : `${profile.name} · ${profile.model}`}</option>)}
      </select>
    </label>
    <label className="sa-chip">
      <Sparkles size={12} />
      <span>思考</span>
      <select
        aria-label="这个对话的思考强度"
        value={value.effort}
        disabled={disabled}
        onChange={event => onChange({ ...value, effort: event.target.value })}
      >
        {EFFORTS.map(option => <option key={option} value={option}>{EFFORT_LABELS[option]}{supported.has(option) ? '' : '（未验证）'}</option>)}
      </select>
    </label>
    {supported.size <= 1 && <span className="sa-modelbar-hint">该模型未声明其它档位；选了被拒绝的档位会自动按默认档重试</span>}
  </div>;
}

/** 外部 CLI 的模型/思考强度：模型可自由填写（支持 --model 的 CLI 会生效）。 */
export function CliModelPicker({ executorId, executorName, value, onChange, disabled }: {
  executorId: string;
  executorName?: string;
  value: { model: string; effort: string };
  onChange: (next: { model: string; effort: string }) => void;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    api.modelHub()
      .then(payload => {
        if (!alive) return;
        const names = [...new Set((payload.profiles || []).map(profile => profile.model).filter(Boolean))];
        setModels(names);
      })
      .catch(() => { if (alive) setModels([]); });
    return () => { alive = false; };
  }, [executorId]);
  const listId = `cli-models-${executorId.replace(/[^a-z0-9-]/gi, '')}`;
  return <div className="sa-modelbar" role="group" aria-label="模型设置">
    <label className="sa-chip sa-chip-input">
      <Bot size={12} />
      <span>模型</span>
      <input
        aria-label={`${executorName || executorId} 使用的模型`}
        list={listId}
        value={value.model}
        disabled={disabled}
        placeholder="默认（CLI 自带）"
        onChange={event => onChange({ ...value, model: event.target.value })}
      />
      <datalist id={listId}>{models.map(name => <option key={name} value={name} />)}</datalist>
    </label>
    <label className="sa-chip">
      <Sparkles size={12} />
      <span>思考</span>
      <select
        aria-label={`${executorName || executorId} 的思考强度`}
        value={value.effort}
        disabled={disabled}
        onChange={event => onChange({ ...value, effort: event.target.value })}
      >
        {EFFORTS.map(option => <option key={option} value={option}>{EFFORT_LABELS[option]}</option>)}
      </select>
    </label>
    <span className="sa-modelbar-hint">留空使用 CLI 自带模型；Codex / Claude Code 已支持模型与思考强度，其它 CLI 可能忽略。</span>
  </div>;
}