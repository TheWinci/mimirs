NAME=value
readonly LIMIT=10
export PATH="/bin:$PATH"
declare -r FIXED=yes
typeset -ir COUNT=2

result="$(load)"
items=(one two)
foo=bar command arg
