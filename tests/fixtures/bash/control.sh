produce | transform | consume

if check_ready; then
  start_service
else
  report_failure
fi

for item in one two; do
  process "$item"
done
