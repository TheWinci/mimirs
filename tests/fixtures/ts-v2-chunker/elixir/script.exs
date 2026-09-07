alias Jason.Encoder

payload = %{name: "mimirs"}
encoded = Encoder.encode(payload)

IO.puts(encoded)
