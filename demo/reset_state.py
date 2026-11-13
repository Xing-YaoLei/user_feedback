"""开发期辅助脚本：重置演示用的 state 目录。"""

import shutil

shutil.rmtree("state", ignore_errors=True)
print("state 目录已重置")
