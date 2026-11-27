import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 结论文本按 Markdown 渲染：段间留白、列表、表格与代码块都能正常阅读。
 * 单独抽出来给会话汇总、各 Agent 结论和运行结果共用。
 */
export function ResultMarkdown({ text, className = '' }: { text: string; className?: string }) {
  return <div className={`sa-md ${className}`.trim()}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        table: ({ node: _node, ...props }) => <div className="sa-md-table"><table {...props} /></div>
      }}
    >{text}</ReactMarkdown>
  </div>;
}
