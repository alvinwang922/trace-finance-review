import datetime
import json
from pathlib import Path

helper = Path('/private/tmp/sense_readiness.py').read_text()
exec(compile(helper.split('allowed =', 1)[0], '/private/tmp/sense_readiness.py', 'exec'))

test_id = 'd0e0693b-027a-4af5-947b-75f754c9ad48'
captured_at = datetime.datetime.now(datetime.timezone.utc)
stamp = captured_at.strftime('%Y%m%dT%H%M%SZ')
output_dir = Path('/Users/alvinwang922/Documents/Codex/2026-10-10/i-am-building-a-hackathon-project/research')
output_dir.mkdir(parents=True, exist_ok=True)
result = {'captured_at_utc': captured_at.isoformat(), 'test_id': test_id}

catalog = rpc({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
tool_list = catalog.get('result', {}).get('tools', [])
result['relevant_tool_schemas'] = [tool for tool in tool_list if tool.get('name') in {'get_results', 'get_status'} or 'transcript' in tool.get('name', '').lower()]
result['tool_names'] = [tool.get('name') for tool in tool_list]
for rpc_id, tool_name in enumerate(['get_results', 'get_status'], 3):
    response = rpc({'jsonrpc': '2.0', 'id': rpc_id, 'method': 'tools/call', 'params': {
        'name': tool_name, 'arguments': {'test_id': test_id}}})
    result[tool_name] = {
        'retrieved_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'response': response,
    }

output_path = output_dir / f'sense-results-status-{stamp}.json'
output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps({'saved_to': str(output_path), 'data': result}, ensure_ascii=False, indent=2))
