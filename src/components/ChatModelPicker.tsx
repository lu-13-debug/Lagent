import { useEffect, useState } from 'react';
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

  return <div className="sa-modelbar">
    <label className="sa-modelbar-field">
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
    <label className="sa-modelbar-field">
      <span>思考强度</span>
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