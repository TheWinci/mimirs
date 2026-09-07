module Fixtures
  module Services
    class Worker < BaseWorker
      DEFAULT_LIMIT = build_limit()

      def initialize(client)
        @client = client
      end

      def run
        @client.call
      end

      def self.create
        new()
      end

      class << self
        def configure
          setup()
        end
      end
    end
  end
end
